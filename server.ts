import { AuthenticationType, AuthRequestMapping, CreateEndpoint, CreateEndpointMethodMapping, DestroyEndpoint, DestroyEndpointMethodMapping, EndpointDefinition, EndpointMethodMapping, IApiListPage, ListEndpoint, ListEndpointMethodMapping, ListParams, RetrieveEndpoint, RetrieveEndpointMethodMapping, UpdateEndpoint, UpdateEndpointMethodMapping } from './api';
import { Model, Table } from './db';
import { HttpMethod, HttpRequest, MethodNotAllowed, NoContent } from './http';
import { ApiResponse, HttpResponse, OK, SuccesfulResponse } from './http';
import { convertLambdaRequest, LambdaCallback, LambdaHttpHandler, LambdaHttpRequest } from './lambda';
import { compileUrl } from './url';
import { spread, transformValues } from './utils/objects';
import { upperFirst } from './utils/strings';

export interface Models {
    [name: string]: Model<any, any, any, any>;
}
export type Tables<T> = {
    [P in keyof T]: Table<T[P]>;
};

export type EndpointHandler<I, O, D, R extends HttpRequest = HttpRequest> = (input: I, models: D, request: R) => Promise<SuccesfulResponse<O>>;
export type EndpointHandlers<D> = {
    [P in HttpMethod]?: EndpointHandler<any, any, D>;
};

export interface HttpRequestHandler {
    endpoint: EndpointDefinition<any, EndpointMethodMapping>;
    execute(request: HttpRequest): Promise<HttpResponse | null>;
}

export interface RetrievableEndpoint<I, O, A extends AuthenticationType> {
    endpoint: EndpointDefinition<RetrieveEndpoint<I, O>, RetrieveEndpointMethodMapping<A>>;
}
export interface CreatableEndpoint<I1, I2, O, A extends AuthenticationType> {
    endpoint: EndpointDefinition<CreateEndpoint<I1, I2, O>, CreateEndpointMethodMapping<A>>;
}
export interface ListableEndpoint<I, O, K extends keyof O, A extends AuthenticationType> {
    endpoint: EndpointDefinition<ListEndpoint<I & ListParams<O, K>, O>, ListEndpointMethodMapping<A>>;
}
export interface UpdateableEndpoint<I1, I2, P, S, A extends AuthenticationType> {
    endpoint: EndpointDefinition<UpdateEndpoint<I1, I2, P, S>, UpdateEndpointMethodMapping<A>>;
}
export interface DestroyableEndpoint<I, A extends AuthenticationType> {
    endpoint: EndpointDefinition<DestroyEndpoint<I>, DestroyEndpointMethodMapping<A>>;
}

export class EndpointImplementation<D, T, H extends EndpointMethodMapping> implements HttpRequestHandler {
    constructor(public endpoint: EndpointDefinition<T, H>, public tables: Tables<D>, private handlers: EndpointHandlers<D>) {}

    public retrieve<I, O, A extends AuthenticationType>(this: RetrievableEndpoint<I, O, A> & this, handler: (input: I, models: D, request: AuthRequestMapping[A]) => Promise<O>) {
        return this.extend({
            GET: async (input: I, models: D, request: AuthRequestMapping[A]) => {
                const result = await handler(input, models, request);
                return new OK(result);
            },
        });
    }
    public create<X1, X2, Y, A extends AuthenticationType>(this: CreatableEndpoint<X1, X2, Y, A> & this, handler: EndpointHandler<X2, Y, D, AuthRequestMapping[A]>): EndpointImplementation<D, T, H> {
        return this.extend({POST: handler});
    }
    public list<X, Y, K extends keyof Y, A extends AuthenticationType>(this: ListableEndpoint<X, Y, K, A> & this, handler: (input: X, models: D, request: AuthRequestMapping[A]) => Promise<Y[]>) {
        const list = async (input: X & ListParams<Y, K>, models: D, request: AuthRequestMapping[A]): Promise<OK<IApiListPage<Y>>> => {
            const {endpoint} = this;
            const {ordering} = input;
            const results = await handler(input, models, request);
            const {length} = results;
            if (!length) {
                return new OK({next: null, results});
            }
            const last = results[length - 1];
            const nextInput = spread(input, {since: last[ordering]});
            const {path, queryParameters} = endpoint.serializeRequest('GET', nextInput);
            const next = compileUrl(request.apiRoot, path, queryParameters);
            const headers = {Link: `${next}; rel="next"`};
            return new OK({next, results}, headers);
        };
        return this.extend({GET: list});
    }
    public update<X1, X2, P, S, A extends AuthenticationType>(this: UpdateableEndpoint<X1, X2, P, S, A> & this, handler: EndpointHandler<X2 | P, S, D, AuthRequestMapping[A]>) {
        return this.extend({PUT: handler, PATCH: handler});
    }
    public destroy<X, A extends AuthenticationType>(this: DestroyableEndpoint<X, A> & this, handler: (input: X, models: D, request: AuthRequestMapping[A]) => Promise<void>) {
        return this.extend({
            DELETE: async (input: X, models: D, request: AuthRequestMapping[A]) => {
                await handler(input, models, request);
                return new NoContent();
            },
        });
    }

    public async execute(request: HttpRequest): Promise<HttpResponse | null> {
        const {method} = request;
        const {endpoint, tables} = this;
        const {methods} = endpoint;
        const models = getModels(tables, request);
        try {
            // TODO: Refactor so that there is no need to parse for every endpoint
            const input = endpoint.deserializeRequest(request);
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
            const response = await handler(input, models, request);
            if (!response.data) {
                return convertApiResponse(response, request);
            }
            return convertApiResponse({...response, data: endpoint.serializeResponseData(method, response.data)}, request);
        } catch (error) {
            // Determine if the error was a HTTP response
            // tslint:disable-next-line:no-shadowed-variable
            const {statusCode, data, headers} = error || {} as any;
            if (typeof statusCode === 'number' && !isNaN(statusCode) && data != null && typeof headers === 'object') {
                // This was an intentional HTTP error, so it should be considered
                // a successful execution of the lambda function.
                return convertApiResponse(error, request);
            }
            // This doesn't seem like a HTTP response -> Pass through for the internal server error
            throw error;
        }
    }

    private extend(handlers: {[P in HttpMethod]?: EndpointHandler<any, any, D>}): EndpointImplementation<D, T, H> {
        return new EndpointImplementation(this.endpoint, this.tables, Object.assign({}, this.handlers, handlers));
    }
}

export function implement<D, T, H extends EndpointMethodMapping>(endpoint: EndpointDefinition<T, H>, db: Tables<D>): EndpointImplementation<D, T, H> {
    return new EndpointImplementation<D, T, H>(endpoint, db, {});
}

function convertApiResponse(response: ApiResponse<any>, request: HttpRequest): HttpResponse {
    const {statusCode, data, headers} = response;
    const encodedBody = data == null ? '' : JSON.stringify(data);
    return {
        statusCode,
        body: encodedBody,
        headers: {
            'Access-Control-Allow-Origin': request.siteOrigin,
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
            'Access-Control-Allow-Credentials': 'true',
            'Content-Type': 'application/json',
            'Content-Length': String(encodedBody.length),
            ...headers,
        },
    };
}

export class ApiService {

    constructor(
        public readonly implementations: {[endpointName: string]: HttpRequestHandler},
        public readonly dbTables: Tables<Models>,
    ) {}

    public async execute(request: HttpRequest): Promise<HttpResponse> {
        const {implementations} = this;
        for (const endpointName in implementations) {
            if (implementations.hasOwnProperty(endpointName)) {
                const implementation = implementations[endpointName];
                const response = await implementation.execute(request);
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
}

function getModels<M>(db: Tables<M>, request: HttpRequest): M {
    return transformValues(
        db,
        (table: Table<any>) => {
            const tableUri = request.environment[`DatabaseTable${upperFirst(table.name)}URI`];
            return table.getModel(tableUri);
        },
    ) as M;
}
