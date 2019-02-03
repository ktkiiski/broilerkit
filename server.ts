import { AuthenticationType, AuthRequestMapping, Handler, Operation, ResponseHandler } from './api';
import { CognitoModel, users } from './cognito';
import { Model, Table } from './db';
import { HttpMethod, HttpRequest, HttpStatus, isResponse, NoContent, Unauthorized } from './http';
import { ApiResponse, HttpResponse, OK } from './http';
import { convertLambdaRequest, LambdaCallback, LambdaHttpHandler, LambdaHttpRequest } from './lambda';
import { Page } from './pagination';
import { Url } from './url';
import { hasOwnProperty, spread, transformValues, values } from './utils/objects';
import { countBytes, upperFirst } from './utils/strings';

export type Models<T> = T & {users: CognitoModel};
export type Tables<T> = {
    [P in keyof T]: Table<T[P]>;
};

type Implementables<I, O, A extends {[op: string]: AuthenticationType}> = (
    {[P in keyof I]: Operation<I[P], any, any>} &
    {[P in keyof O]: Operation<any, O[P], any>} &
    {[P in keyof A]: Operation<any, any, A[P]>}
);
type OperationImplementors<I, O, D, A extends {[op: string]: AuthenticationType}> = {
    [P in keyof I & keyof O & keyof A]: Handler<I[P], O[P], D, A[P]>;
};
class ImplementedOperation {
    constructor(
        public readonly operation: Operation<any, any, AuthenticationType>,
        private readonly tables: Tables<any>,
        private readonly handler: ResponseHandler<any, any, any, any>,
    ) {}

    public async execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<ApiResponse<any> | null> {
        const {tables, operation} = this;
        const {authType, userIdAttribute, responseSerializer} = operation;
        const models = getModels(tables, request, cache);
        const input = operation.deserializeRequest(request);
        if (!input) {
            // Not matching endpoint
            return null;
        }
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
        }
        // Check the authorization
        if (auth && userIdAttribute && input[userIdAttribute] !== auth.id && !isAdmin) {
            throw new Unauthorized(`Unauthorized resource`);
        }
        // Handle the request
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

export function implement<I, O, A extends AuthenticationType, D>(
    operation: Operation<I, O, A>,
    db: Tables<D>,
    implementation: Handler<I, O, D, A>,
): ImplementedOperation {
    switch (operation.type) {
        case 'list':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: Models<D>, request: AuthRequestMapping[A]): Promise<OK<Page<O, any>>> => {
                const page: Page<any, any> = await implementation(input, models, request) as any;
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
            async (input: I, models: Models<D>, request: AuthRequestMapping[A]): Promise<OK<O>> => {
                return new OK(await implementation(input, models, request));
            },
        );
        case 'destroy':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: Models<D>, request: AuthRequestMapping[A]): Promise<NoContent> => {
                await implementation(input, models, request);
                return new NoContent();
            },
        );
        default:
        // With other methods, use implementation as-is
        return new ImplementedOperation(operation, db, implementation as any);
    }
}

export function implementAll<I, O, A extends {[op: string]: AuthenticationType}, D>(
    operations: Implementables<I, O, A>, db: Tables<D>,
) {
    function using(
        implementors: OperationImplementors<I, O, D, A>,
    ): Record<keyof I & keyof O & keyof A, ImplementedOperation> {
        return transformValues(operations as {[key: string]: Operation<any, any, any>}, (operation, key) => (
            implement(operation, db, implementors[key as keyof I & keyof O & keyof A])
        )) as Record<keyof I & keyof O & keyof A, ImplementedOperation>;
    }
    return {using};
}

async function handleApiRequest(request: HttpRequest, promise: Promise<ApiResponse<any> | null>): Promise<HttpResponse | null> {
    try {
        const apiResponse = await promise;
        return apiResponse && finalizeApiResponse(apiResponse, request.siteOrigin);
    } catch (error) {
        return catchHttpException(error, request);
    }
}

function catchHttpException(error: any, request: HttpRequest): HttpResponse {
    // Determine if the error was a HTTP response
    if (isResponse(error)) {
        // This was an intentional HTTP error, so it should be considered
        // a successful execution of the lambda function.
        return finalizeApiResponse(error, request.siteOrigin);
    }
    // This doesn't seem like a HTTP response -> Pass through for the internal server error
    throw error;
}

export function finalizeApiResponse(response: ApiResponse<any>, siteOrigin: string): HttpResponse {
    const {statusCode, data} = response;
    const encodedBody = data == null ? '' : JSON.stringify(data);
    const headers = data == null
        ? response.headers
        : {'Content-Type': 'application/json', ...response.headers}
    ;
    return {
        statusCode,
        body: encodedBody,
        headers: {
            'Access-Control-Allow-Origin': siteOrigin,
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
            'Access-Control-Allow-Credentials': 'true',
            'Content-Length': String(countBytes(encodedBody)),
            ...headers,
        },
    };
}

export class ApiService {

    constructor(
        public readonly implementations: Record<string, ImplementedOperation>,
        public readonly dbTables: Tables<{[name: string]: Model<any, any, any, any, any>}>,
    ) {}

    public async execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<HttpResponse> {
        let errorResponse: HttpResponse = {
            statusCode: HttpStatus.NotFound,
            body: JSON.stringify({
                message: 'API endpoint not found.',
                request,
            }),
            headers: {
                'Content-Type': 'application/json',
            },
        };
        const implementations = this.iterateForPath(request.path);
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
            return finalizeApiResponse({
                statusCode: 200,
                headers: {'Access-Control-Allow-Methods': methods.join(', ')},
            }, request.siteOrigin);
        }
        // Otherwise find the first implementation that processes the response
        for (const implementation of implementations) {
            const promise = implementation.execute(request, cache);
            const response = await handleApiRequest(request, promise);
            if (response) {
                if (response.statusCode === HttpStatus.MethodNotAllowed) {
                    // The URL matches, but the method is not valid.
                    // Some other implementation might still accept this method,
                    // so continue iterating, or finally return this 405 if not found.
                    errorResponse = response;
                } else {
                    // This implementation handled this response!
                    return response;
                }
            }
        }
        // This should not be possible with API gateway, but possible with the local server
        return errorResponse;
    }

    public request: LambdaHttpHandler = (lambdaRequest: LambdaHttpRequest, _: any, callback: LambdaCallback) => {
        const request = convertLambdaRequest(lambdaRequest);
        this.execute(request).then(
            (result) => callback(null, result),
            (error) => callback(error),
        );
    }

    public extend(implementations: Record<string, ImplementedOperation>, dbTables?: Tables<{[name: string]: Model<any, any, any, any, any>}>) {
        return new ApiService(
            {...this.implementations, ...implementations},
            {...this.dbTables, ...dbTables},
        );
    }

    public getTable(tableName: string): Table<Model<any, any, any, any, any>> | undefined {
        const tableMapping = spread(this.dbTables, {users});
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
        spread(db, {users}) as any,
        (table: Table<any>) => {
            const tableUri = request.environment[`DatabaseTable${upperFirst(table.name)}URI`];
            const model = cache[tableUri];
            return model || (cache[tableUri] = table.getModel(tableUri));
        },
    ) as Models<M>;
}
