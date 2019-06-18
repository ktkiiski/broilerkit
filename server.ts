// tslint:disable:member-ordering
import { Handler, ResponseHandler } from './api';
import { CognitoModel } from './cognito';
import { Model, Table } from './db';
import { BadRequest, HttpMethod, HttpRequest, HttpStatus, isResponse, MethodNotAllowed, NoContent, NotFound, NotImplemented, parseHeaderDirectives, Unauthorized, UnsupportedMediaType } from './http';
import { ApiResponse, HttpResponse, OK } from './http';
import { parseFormData } from './multipart';
import { AuthenticationType, Operation } from './operations';
import { Page } from './pagination';
import { Serializer } from './serializers';
import { Url, UrlPattern } from './url';
import { sort } from './utils/arrays';
import { buildObject, transformValues } from './utils/objects';
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

export interface Controller {
    /**
     * All HTTP methods accepted by this endpoint.
     */
    methods: HttpMethod[];
    /**
     * URL path pattern that matches this endpoint.
     */
    pattern: UrlPattern;
    /**
     * Whether or not this controller requires authenticated user.
     */
    requiresAuth: boolean;
    /**
     * Array of database tables required by this controller.
     */
    tables: Array<Table<any>>;
    /**
     * Respond to the given request with either an API response
     * or a raw HTTP response. The handler should THROW (not return)
     * - 501 HTTP error to indicate that the URL is not for this controller
     * - 405 HTTP error if the request method was one of the `methods`
     */
    execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<ApiResponse | HttpResponse>;
}

class ImplementedOperation implements Controller {

    public readonly methods: HttpMethod[];
    public readonly pattern: UrlPattern;
    public readonly tables: Array<Table<any>>;
    public readonly requiresAuth: boolean;

    constructor(
        public readonly operation: Operation<any, any, AuthenticationType>,
        public readonly tablesByName: Tables<any>,
        private readonly handler: ResponseHandler<any, any, any, any>,
    ) {
        const {methods, route, authType} = operation;
        this.methods = methods;
        this.pattern = route.pattern;
        this.tables = Object.values(tablesByName);
        this.requiresAuth = authType !== 'none';
    }

    public async execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<ApiResponse> {
        const {tablesByName, operation} = this;
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
        const models = getModels(tablesByName, request, cache);
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
): Controller {
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
                const next = `${request.serverOrigin}${url}`;
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
    ): Record<keyof I & keyof O & keyof R, Controller> {
        return transformValues(operations as {[key: string]: Operation<any, any, any>}, (operation, key) => (
            implement(operation, db, implementors[key as keyof I & keyof O & keyof R])
        )) as Record<keyof I & keyof O & keyof R, Controller>;
    }
    return {using};
}

export class ApiService {

    public readonly tables: Array<Table<Model<any, any, any, any, any>>>;
    public readonly controllers: Controller[];

    constructor(
        public readonly controllersByName: Record<string, Controller>,
    ) {
        const tablesByName: Record<string, Table<Model<any, any, any, any, any>>> = {};
        // IMPORTANT: Sort controllers by pattern, because this way static path components
        // take higher priority than placeholders, e.g. `/api/foobar` comes before `/{path+}`
        this.controllers = sort(Object.values(controllersByName), ({pattern}) => pattern.pattern, 'asc');
        this.controllers.forEach((controller) => {
            Object.values(controller.tables).forEach((table) => {
                tablesByName[table.name] = table;
            });
        });
        this.tables = Object.values(tablesByName);
    }

    public execute = async (request: HttpRequest, cache?: {[uri: string]: any}) => {
        let errorResponse: ApiResponse | HttpResponse = new NotFound(`API endpoint not found.`);
        // TODO: Configure TypeScript to allow using iterables on server side
        const controllers = Array.from(this.iterateForPath(request.path));
        // Respond to an OPTIONS request
        if (request.method === 'OPTIONS') {
            // Get the combined methods of all matching operations
            const methods: HttpMethod[] = [];
            for (const controller of controllers) {
                methods.push(...controller.methods);
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
        for (const implementation of controllers) {
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

    public extend(controllers: Record<string, Controller>) {
        return new ApiService({...this.controllersByName, ...controllers});
    }

    public getTable(tableName: string): Table<Model<any, any, any, any, any>> | undefined {
        return this.tables.find((table) => table.name === tableName);
    }

    private *iterateForPath(path: string) {
        const url = new Url(path);
        for (const controller of this.controllers) {
            // NOTE: We just make a simple match against the path!
            if (controller.pattern.match(url)) {
                yield controller;
            }
        }
    }
}

function getModels<M>(db: Tables<M>, request: HttpRequest, cache: {[uri: string]: any} = {}): Models<M> {
    return transformValues(db, (table) => {
        const environmentKey = `DatabaseTable${upperFirst(table.name)}URI`;
        const tableUri = request.environment[environmentKey] as string | undefined;
        if (!tableUri) {
            throw new Error(`Environment does not define URI for the table "${table.name}"`);
        }
        const model = cache[tableUri];
        return model || (cache[tableUri] = table.getModel(tableUri));
    }) as Models<M>;
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
