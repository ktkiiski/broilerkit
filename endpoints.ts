import forEach = require('lodash/forEach');
import includes = require('lodash/includes');
import isNumber = require('lodash/isNumber');
import isObject = require('lodash/isObject');
import isString = require('lodash/isString');
import mapValues = require('lodash/mapValues');
import { Subscribable } from 'rxjs/Observable';
import { defer } from 'rxjs/observable/defer';
import { of } from 'rxjs/observable/of';
import { Api } from './api';
import { Field } from './fields';
import { isReadHttpMethod, isWriteHttpMethod } from './http';
import { HttpHeaders, HttpResponse } from './http';
import { HttpCallback, HttpHandler, HttpStatus } from './http';
import { HttpRequest, HttpRequestContext } from './http';
import { ExceptionResponse, SuccesfulResponse } from './http';

declare const __SITE_ORIGIN__: string;

export type ApiResponse<O> = SuccesfulResponse<O> | ExceptionResponse;
export type ApiEndpointHandler<I extends object, O> = (input: I, event: HttpRequest, context: HttpRequestContext) => Subscribable<ApiResponse<O>> | Promise<ApiResponse<O>>;

class ApiError extends Error implements HttpResponse {
    public readonly body: string;
    constructor(public statusCode: HttpStatus, message: string, public headers: HttpHeaders = {}) {
        super(message);
        this.body = JSON.stringify({message});
    }
}

export interface IPage<T> {
    next: string | null;
    results: T[];
}

export class ApiEndpoint<I extends object, O> implements IApiEndpoint<I> {

    public readonly path: string[];

    constructor(public api: Api<I>, private run: ApiEndpointHandler<I, O>) {
        this.path = api.url.replace(/^\/|\/$/, '').split('/');
    }

    public deserialize(event: HttpRequest): Subscribable<I> {
        const {httpMethod, queryStringParameters, body, pathParameters} = event;
        const decodedPathParameters = mapValues(pathParameters, (value) => {
            if (!value) {
                return value;
            }
            try {
                return decodeURIComponent(value);
            } catch (e) {
                throw new ApiError(HttpStatus.BadRequest, `Invalid URL component`);
            }
        });
        if (!includes(this.api.methods, httpMethod)) {
            throw new ApiError(HttpStatus.MethodNotAllowed, `Method ${httpMethod} is not allowed`);
        }
        let input = {...queryStringParameters, ...decodedPathParameters};
        if (body) {
            let payload;
            try {
                payload = JSON.parse(body);
            } catch (e) {
                throw new ApiError(HttpStatus.BadRequest, `Request payload is not valid JSON`);
            }
            if (!isObject(payload)) {
                throw new ApiError(HttpStatus.BadRequest, `Request payload is not a JSON object`);
            }
            input = {...input, ...payload};
        }
        return of(
            mapValues(this.api.params, (field: Field<any>, name) => {
                try {
                    return field.deserialize(input[name]);
                } catch (error) {
                    if (error.invalid) {
                        throw new ApiError(HttpStatus.BadRequest, JSON.stringify({[name]: error.message}));
                    }
                    throw error;
                }
            }),
        );
    }

    public execute(event: HttpRequest, context: HttpRequestContext, callback: HttpCallback) {
        defer(() => this.deserialize(event))
            .switchMap((input) => this.run(input, event, context))
            .map(({statusCode, data, headers}) => {
                const body = data === undefined ? '' : JSON.stringify(data);
                return {
                    statusCode, body,
                    headers: {
                        ...headers,
                        'Content-Type': 'application/json',
                        'Content-Length': String(body.length),
                    },
                } as HttpResponse;
            })
            .catch((error) => {
                // Determine if the error was a HTTP response
                const {statusCode, body, headers} = error || {} as any;
                if (isNumber(statusCode) && isString(body) && isObject(headers)) {
                    // This was an intentional HTTP error, so it should be considered
                    // a successful execution of the lambda function.
                    return of(error as HttpResponse);
                }
                throw error;
            })
            // Ensure that the response contains the CORS headers
            .map((response) => ({
                ...response,
                headers: {
                    'Access-Control-Allow-Origin': __SITE_ORIGIN__,
                    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
                    'Access-Control-Allow-Credentials': 'true',
                    ...response.headers,
                },
            }))
            .single()
            .subscribe({
                next: (result) => callback(null, result),
                error: (error) => callback(error),
            })
        ;
    }
}

export interface IApiEndpoint<I extends object> {
    api: Api<I>;
    path: string[];
    execute: HttpHandler;
}

export class ApiRequestHandler<T extends {[endpoint: string]: IApiEndpoint<any>}> {

    private readonly endpointMapping: {[url: string]: IApiEndpoint<any>};

    constructor(public readonly endpoints: T) {
        this.endpointMapping = {};
        forEach(endpoints, (endpoint) => {
            forEach(endpoint.api.methods, (method) => {
                this.endpointMapping[`${method} ${endpoint.api.url}`] = endpoint;
            });
        });
    }

    public request: HttpHandler = (request: HttpRequest, context: HttpRequestContext, callback: HttpCallback) => {
        request = this.normalizeRequest(request);
        const endpoint = this.endpointMapping[`${request.httpMethod} ${request.resource}`];
        if (endpoint) {
            endpoint.execute(request, context, callback);
        } else {
            // This should not be possible if API gateway was configured correctly
            callback(null, {
                statusCode: 404,
                body: JSON.stringify({
                    message: 'API endpoint not found.',
                    request: {
                        resource: request.resource,
                        path: request.path,
                        httpMethod: request.httpMethod,
                        queryStringParameters: request.queryStringParameters,
                    },
                }),
                headers: {
                    'Content-Type': 'application/json',
                },
            });
        }
    }

    protected normalizeRequest(request: HttpRequest): HttpRequest {
        let {httpMethod} = request;
        const {queryStringParameters} = request;
        const {method = null} = queryStringParameters || {};
        if (method) {
            // Allow changing the HTTP method with 'method' query string parameter
            if (httpMethod === 'GET' && isReadHttpMethod(method)) {
                httpMethod = method;
            } else if (httpMethod === 'POST' && isWriteHttpMethod(method)) {
                httpMethod = method;
            } else {
                throw new ApiError(HttpStatus.BadRequest, `Cannot perform ${httpMethod} as ${method} request`);
            }
        }
        // Return with possible changed HTTP method
        return { ...request, httpMethod };
    }
}
