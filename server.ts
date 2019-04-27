// tslint:disable:member-ordering
import { Handler, ResponseHandler } from './api';
import { CognitoModel, users } from './cognito';
import { Model, Table } from './db';
import { BadRequest, HttpMethod, HttpRequest, HttpStatus, isResponse, MethodNotAllowed, NoContent, NotFound, NotImplemented, parseHeaderDirectives, Unauthorized, UnsupportedMediaType } from './http';
import { ApiResponse, HttpResponse, OK } from './http';
import { parseFormData } from './multipart';
import { AuthenticationType, Operation } from './operations';
import { Page } from './pagination';
import { Serializer } from './serializers';
import { Url } from './url';
import { buildObject, hasOwnProperty, transformValues, values } from './utils/objects';
import { upperFirst } from './utils/strings';

export type Models<T> = T & {users: CognitoModel};
export type Tables<T> = {
    [P in keyof T]: Table<T[P]>;
};

type Implementables<I, O, R> = (
    {[P in keyof I]: Operation<I[P], any, any>} &
    {[P in keyof O]: Operation<any, O[P], any>} &
    {[P in keyof R]: Operation<any, any, R[P]>}
);
type OperationImplementors<I, O, D, R> = {
    [P in keyof I & keyof O & keyof R]: Handler<I[P], O[P], D, R[P]>;
};
class ImplementedOperation {
    constructor(
        public readonly operation: Operation<any, any, AuthenticationType>,
        private readonly tables: Tables<any>,
        private readonly handler: ResponseHandler<any, any, any, any>,
    ) {}

    public async execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<ApiResponse> {
        const {tables, operation} = this;
        const {authType, userIdAttribute, responseSerializer} = operation;
        const input = parseRequest(operation, request);
        // Check the authentication
        const {auth} = request;
        const isAdmin = !!auth && auth.groups.indexOf('Administrators') < 0;
        if (authType !== 'none') {
            if (!auth) {
                throw new Unauthorized(`Unauthorized`);
            }
            if (authType === 'admin' && isAdmin) {
                // Not an admin!
                throw new Unauthorized(`Administrator rights are missing.`);
            }
            if (authType !== 'user') {
                // Needs to be either owner or admin!
                // TODO: Handle invalid configuration where auth == 'owner' && !userIdAttribute!
                if (userIdAttribute && input[userIdAttribute] !== auth.id && !isAdmin) {
                    throw new Unauthorized(`Unauthorized resource`);
                }
            }
        }
        // Handle the request
        const models = getModels(tables, request, cache);
        const {data, ...response} = await this.handler(input, models, request);
        if (!responseSerializer) {
            // No response data should be available
            return response;
        }
        // Serialize the response data
        // TODO: Validation errors should result in 500 responses!
        return {...response, data: responseSerializer.serialize(data)};
    }
}

export function implement<I, O, R, D>(
    operation: Operation<I, O, R>,
    db: Tables<D>,
    implementation: Handler<I, O, D, R>,
): ImplementedOperation {
    switch (operation.type) {
        case 'list':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: Models<D>, request: HttpRequest): Promise<OK<Page<O, any>>> => {
                // TODO: Avoid force-typecasting of request!
                const page: Page<any, any> = await implementation(input, models, request as unknown as R) as any;
                if (!page.next) {
                    return new OK(page);
                }
                const url = operation.route.compile(page.next);
                const next = `${request.apiRoot}${url}`;
                const headers = {Link: `${next}; rel="next"`};
                return new OK(page, headers);
            },
        );
        case 'retrieve':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: Models<D>, request: R): Promise<OK<O>> => {
                return new OK(await implementation(input, models, request));
            },
        );
        case 'destroy':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: Models<D>, request: R): Promise<NoContent> => {
                await implementation(input, models, request);
                return new NoContent();
            },
        );
        default:
        // With other methods, use implementation as-is
        return new ImplementedOperation(operation, db, implementation as any);
    }
}

export function implementAll<I, O, R, D>(
    operations: Implementables<I, O, R>, db: Tables<D>,
) {
    function using(
        implementors: OperationImplementors<I, O, D, R>,
    ): Record<keyof I & keyof O & keyof R, ImplementedOperation> {
        return transformValues(operations as {[key: string]: Operation<any, any, any>}, (operation, key) => (
            implement(operation, db, implementors[key as keyof I & keyof O & keyof R])
        )) as Record<keyof I & keyof O & keyof R, ImplementedOperation>;
    }
    return {using};
}

export class ApiService {

    constructor(
        public readonly implementations: Record<string, ImplementedOperation>,
        public readonly dbTables: Tables<{[name: string]: Model<any, any, any, any, any>}>,
    ) {}

    public execute = async (request: HttpRequest, cache?: {[uri: string]: any}) => {
        let errorResponse: ApiResponse | HttpResponse = new NotFound(`API endpoint not found.`);
        // TODO: Configure TypeScript to allow using iterables on server side
        const implementations = Array.from(this.iterateForPath(request.path));
        // Respond to an OPTIONS request
        if (request.method === 'OPTIONS') {
            // Get the combined methods of all matching operations
            const methods: HttpMethod[] = [];
            for (const implementation of implementations) {
                methods.push(...implementation.operation.methods);
            }
            // If no methods found, then this is a unknown URL
            // This should not be possible with API gateway, but possible with the local server
            if (!methods.length) {
                return errorResponse;
            }
            // Respond with the CORS headers
            return {
                statusCode: 200,
                headers: {'Access-Control-Allow-Methods': methods.join(', ')},
                body: '',
            } as HttpResponse;
        }
        // Otherwise find the first implementation that processes the response
        for (const implementation of implementations) {
            try {
                // Return response directly returned by the implementation
                return await implementation.execute(request, cache);
            } catch (error) {
                // Thrown 405 or 501 response errors will have a special meaning
                if (isResponse(error)) {
                    if (error.statusCode === HttpStatus.NotImplemented) {
                        // Continue to the next implementation
                        continue;
                    } else if (error.statusCode === HttpStatus.MethodNotAllowed) {
                        // The URL matches, but the method is not valid.
                        // Some other implementation might still accept this method,
                        // so continue iterating, or finally return this 405 if not found.
                        errorResponse = error;
                        continue;
                    }
                }
                // Raise through
                throw error;
            }
        }
        // This should not be possible with API gateway, but possible with the local server
        return errorResponse;
    }

    public extend(implementations: Record<string, ImplementedOperation>, dbTables?: Tables<{[name: string]: Model<any, any, any, any, any>}>) {
        return new ApiService(
            {...this.implementations, ...implementations},
            {...this.dbTables, ...dbTables},
        );
    }

    public getTable(tableName: string): Table<Model<any, any, any, any, any>> | undefined {
        const tableMapping = {...this.dbTables, users};
        const tables = values(tableMapping);
        return tables.find((table) => table.name === tableName);
    }

    private *iterateForPath(path: string) {
        const url = new Url(path);
        const {implementations} = this;
        for (const endpointName in implementations) {
            if (hasOwnProperty(implementations, endpointName)) {
                const implementation = implementations[endpointName];
                if (implementation) {
                    const {route} = implementation.operation;
                    // NOTE: We just make a simple match against the path!
                    if (route.pattern.match(url)) {
                        yield implementation;
                    }
                }
            }
        }
    }
}

function getModels<M>(db: Tables<M>, request: HttpRequest, cache: {[uri: string]: any} = {}): Models<M> {
    return transformValues(
        {...db, users},
        (table) => {
            const environmentKey = `DatabaseTable${upperFirst(table.name)}URI`;
            const tableUri = request.environment[environmentKey] as string | undefined;
            if (!tableUri) {
                throw new Error(`Environment does not define URI for the table "${table.name}"`);
            }
            const model = cache[tableUri];
            return model || (cache[tableUri] = table.getModel(tableUri));
        },
    ) as Models<M>;
}

function parseRequest<I>(operation: Operation<I, any, any>, request: HttpRequest): I {
    const {path, queryParameters, method, body, headers} = request;
    const url = new Url(path, queryParameters);
    if (!operation.route.pattern.match(url)) {
        // The pattern doesn't match this URL path
        // Not matching endpoint
        // This error code indicates to the caller that it should probably find another endpoint
        throw new NotImplemented(`Request not processable by this endpoint`);
    }
    if (operation.methods.indexOf(method) < 0) {
        // URL matches but the method is not accepted
        throw new MethodNotAllowed(`Method ${method} is not allowed`);
    }
    // NOTE: Raises validation error if matches but invalid
    const urlParameters = operation.route.match(url);
    const payloadSerializer = operation.getPayloadSerializer(method);
    if (!payloadSerializer) {
        // No payload, just URL parameters
        return urlParameters;
    }
    // Deserialize/decode the payload, raising validation error if invalid
    const payload = parsePayload(payloadSerializer, body, headers['Content-Type']);
    // TODO: Gather validation errors togeter?
    return {...urlParameters, ...payload};
}

function parsePayload(serializer: Serializer, body?: string, contentTypeHeader: string = 'application/json'): any {
    if (!body) {
        // Empty body equals to an empty object
        // This way body may be omitted if the endpoint takes no payload input.
        return serializer.deserialize({});
    }
    const [contentType, meta] = parseHeaderDirectives(contentTypeHeader);
    if (contentType === 'application/json') {
        // Deserialize JSON
        const payload = parseJSON(body);
        return serializer.deserialize(payload);

    } else if (contentType === 'multipart/form-data') {
        // Decode multipart/form-data
        const formData = parseFormData(body, meta.boundary);
        const payload = buildObject(formData, (part) => (
            part.name ? [part.name, part.body] : undefined
        ));
        return serializer.decode(payload);
    }
    throw new UnsupportedMediaType(`Only 'application/json' requests are accepted`);
}

function parseJSON(body: string) {
    try {
        return JSON.parse(body);
    } catch {
        throw new BadRequest(`Invalid JSON payload`);
    }
}
