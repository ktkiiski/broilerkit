import { AuthenticationType, AuthRequestMapping, CreateEndpoint, CreateEndpointMethodMapping, DestroyEndpoint, DestroyEndpointMethodMapping, EndpointDefinition, EndpointMethodMapping, ListEndpoint, ListEndpointMethodMapping, RetrieveEndpoint, RetrieveEndpointMethodMapping, UpdateEndpoint, UpdateEndpointMethodMapping } from './api';
import { CognitoModel, users } from './cognito';
import { Model, Table } from './db';
import { HttpMethod, HttpRequest, isResponse, MethodNotAllowed, NoContent, Unauthorized } from './http';
import { ApiResponse, HttpResponse, OK, SuccesfulResponse } from './http';
import { convertLambdaRequest, LambdaCallback, LambdaHttpHandler, LambdaHttpRequest } from './lambda';
import { OrderedQuery, Page } from './pagination';
import { Url } from './url';
import { spread, transformValues } from './utils/objects';
import { countBytes, upperFirst } from './utils/strings';

export type Models<T> = T & {users: CognitoModel};
export type Tables<T> = {
    [P in keyof T]: Table<T[P]>;
};

export type EndpointHandler<I, O, D, R extends HttpRequest = HttpRequest> = (input: I, models: Models<D>, request: R) => Promise<SuccesfulResponse<O>>;
export type EndpointHandlers<D> = {
    [P in HttpMethod]?: EndpointHandler<any, any, D>;
};

export interface HttpRequestHandler {
    endpoint: EndpointDefinition<any, EndpointMethodMapping>;
    execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<HttpResponse | null>;
}

export interface RetrievableEndpoint<I, O, A extends AuthenticationType> {
    endpoint: EndpointDefinition<RetrieveEndpoint<I, O, any>, RetrieveEndpointMethodMapping<A>>;
}
export interface CreatableEndpoint<I1, I2, O, A extends AuthenticationType> {
    endpoint: EndpointDefinition<CreateEndpoint<I1, I2, O, any>, CreateEndpointMethodMapping<A>>;
}
export interface ListableEndpoint<I, O, K extends keyof O, A extends AuthenticationType> {
    endpoint: EndpointDefinition<ListEndpoint<I & OrderedQuery<O, K>, O, any>, ListEndpointMethodMapping<A>>;
}
export interface UpdateableEndpoint<I1, I2, P, S, A extends AuthenticationType> {
    endpoint: EndpointDefinition<UpdateEndpoint<I1, I2, P, S, any>, UpdateEndpointMethodMapping<A>>;
}
export interface DestroyableEndpoint<I, A extends AuthenticationType> {
    endpoint: EndpointDefinition<DestroyEndpoint<I, any>, DestroyEndpointMethodMapping<A>>;
}

export class EndpointImplementation<D, T, H extends EndpointMethodMapping> implements HttpRequestHandler {
    constructor(public endpoint: EndpointDefinition<T, H>, public tables: Tables<D>, private handlers: EndpointHandlers<D>) {}

    public retrieve<I, O, A extends AuthenticationType>(this: RetrievableEndpoint<I, O, A> & this, handler: (input: I, models: Models<D>, request: AuthRequestMapping[A]) => Promise<O>) {
        return this.extend({
            GET: async (input: I, models: Models<D>, request: AuthRequestMapping[A]) => {
                const result = await handler(input, models, request);
                return new OK(result);
            },
        });
    }
    public create<X1, X2, Y, A extends AuthenticationType>(this: CreatableEndpoint<X1, X2, Y, A> & this, handler: EndpointHandler<X2, Y, Models<D>, AuthRequestMapping[A]>): EndpointImplementation<D, T, H> {
        return this.extend({POST: handler});
    }
    public list<X, Y, K extends keyof Y, A extends AuthenticationType>(this: ListableEndpoint<X, Y, K, A> & this, handler: (input: X, models: Models<D>, request: AuthRequestMapping[A]) => Promise<Page<Y, X & OrderedQuery<Y, K>>>) {
        const list = async (input: X & OrderedQuery<Y, K>, models: Models<D>, request: AuthRequestMapping[A]): Promise<OK<Page<Y, X & OrderedQuery<Y, K>>>> => {
            const {endpoint} = this;
            const page = await handler(input, models, request);
            if (!page.next) {
                return new OK(page);
            }
            const {url} = endpoint.serializeRequest('GET', page.next);
            const next = `${request.apiRoot}${url}`;
            const headers = {Link: `${next}; rel="next"`};
            return new OK(page, headers);
        };
        return this.extend({GET: list});
    }
    public update<X1, X2, P, S, A extends AuthenticationType>(this: UpdateableEndpoint<X1, X2, P, S, A> & this, handler: EndpointHandler<X2 | P, S, D, AuthRequestMapping[A]>) {
        return this.extend({PUT: handler, PATCH: handler});
    }
    public destroy<X, A extends AuthenticationType>(this: DestroyableEndpoint<X, A> & this, handler: (input: X, models: Models<D>, request: AuthRequestMapping[A]) => Promise<void>) {
        return this.extend({
            DELETE: async (input: X, models: Models<D>, request: AuthRequestMapping[A]) => {
                await handler(input, models, request);
                return new NoContent();
            },
        });
    }

    public execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<HttpResponse | null> {
        const {method, payload} = request;
        const {endpoint, tables} = this;
        const {methods} = endpoint;
        const models = getModels(tables, request, cache);
        return handleApiRequest(request, async () => {
            const url = new Url(request.path, request.queryParameters);
            const input = endpoint.deserializeRequest({method, url, payload});
            if (!input) {
                return null;
            }
            // Respond to an OPTIONS request
            if (method === 'OPTIONS') {
                // Respond with the CORS headers
                return {
                    statusCode: 200,
                    headers: {
                        'Access-Control-Allow-Origin': request.siteOrigin,
                        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
                        'Access-Control-Allow-Methods': methods.join(', '),
                        'Access-Control-Allow-Credentials': 'true',
                    },
                    body: '',
                };
            }
            const handler = this.handlers[method];
            // Check that the API function was called with an accepted HTTP method
            if (!handler) {
                throw new MethodNotAllowed(`Method ${method} is not allowed`);
            }
            // Check the authentication
            const {auth} = request;
            const isAdmin = !!auth && auth.groups.indexOf('Administrators') < 0;
            const authType = endpoint.getAuthenticationType(method);
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
            const {userIdAttribute} = endpoint;
            if (auth && userIdAttribute && input[userIdAttribute] !== auth.id && !isAdmin) {
                throw new Unauthorized(`Unauthorized resource`);
            }
            // Handle the request
            const response = await handler(input, models, request);
            if (!response.data) {
                return response;
            }
            return {...response, data: endpoint.serializeResponseData(method, response.data)};
        });
    }

    private extend(handlers: {[P in HttpMethod]?: EndpointHandler<any, any, D>}): EndpointImplementation<D, T, H> {
        return new EndpointImplementation(this.endpoint, this.tables, Object.assign({}, this.handlers, handlers));
    }
}

export function implement<D, T, H extends EndpointMethodMapping>(endpoint: EndpointDefinition<T, H>, db: Tables<D>): EndpointImplementation<D, T, H> {
    return new EndpointImplementation<D, T, H>(endpoint, db, {});
}

function handleApiRequest(request: HttpRequest, handler: () => Promise<ApiResponse<any> | null>): Promise<HttpResponse | null> {
    return handler().then(
        (apiResponse) => apiResponse && finalizeApiResponse(apiResponse, request.siteOrigin),
        (error) => catchHttpException(error, request),
    );
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
    const {statusCode, data, headers} = response;
    const encodedBody = data == null ? '' : JSON.stringify(data);
    return {
        statusCode,
        body: encodedBody,
        headers: {
            'Access-Control-Allow-Origin': siteOrigin,
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Content-Length': String(countBytes(encodedBody)),
            ...headers,
        },
    };
}

export class ApiService {

    constructor(
        public readonly implementations: {[endpointName: string]: HttpRequestHandler},
        public readonly dbTables: Tables<{[name: string]: Model<any, any, any, any, any>}>,
    ) {}

    public async execute(request: HttpRequest, cache?: {[uri: string]: any}): Promise<HttpResponse> {
        const {implementations} = this;
        for (const endpointName in implementations) {
            if (implementations.hasOwnProperty(endpointName)) {
                const implementation = implementations[endpointName];
                const response = await implementation.execute(request, cache);
                if (response) {
                    return response;
                }
            }
        }
        // This should not be possible with API gateway, but possible with the local server
        return {
            statusCode: 404,
            body: JSON.stringify({
                message: 'API endpoint not found.',
                request,
            }),
            headers: {
                'Content-Type': 'application/json',
            },
        };
    }

    public request: LambdaHttpHandler = (lambdaRequest: LambdaHttpRequest, _: any, callback: LambdaCallback) => {
        const request = convertLambdaRequest(lambdaRequest);
        this.execute(request).then(
            (result) => callback(null, result),
            (error) => callback(error),
        );
    }

    public extend(implementations: {[endpointName: string]: HttpRequestHandler}, dbTables?: Tables<{[name: string]: Model<any, any, any, any, any>}>) {
        return new ApiService(
            {...this.implementations, ...implementations},
            {...this.dbTables, ...dbTables},
        );
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
