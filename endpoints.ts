import forEach = require('lodash/forEach');
import includes = require('lodash/includes');
import isNumber = require('lodash/isNumber');
import isObject = require('lodash/isObject');
import isString = require('lodash/isString');
import mapValues = require('lodash/mapValues');
import { Api } from './api';
import { Field } from './fields';
import { BadRequest, MethodNotAllowed } from './http';
import { isReadHttpMethod, isWriteHttpMethod } from './http';
import { HttpCallback, HttpHandler, HttpResponse } from './http';
import { HttpRequest, HttpRequestContext } from './http';
import { ApiResponse, SuccesfulResponse } from './http';

declare const __SITE_ORIGIN__: string;

export type ApiEndpointHandler<I extends object, O> = (input: I, event: HttpRequest, context: HttpRequestContext) => Promise<SuccesfulResponse<O>>;

export interface IPage<T> {
    next: string | null;
    results: T[];
}

export class ApiEndpoint<I extends object, O> implements IApiEndpoint<I> {

    public readonly path: string[];

    constructor(public api: Api<I>, private run: ApiEndpointHandler<I, O>) {
        this.path = api.url.replace(/^\/|\/$/, '').split('/');
    }

    public async deserialize(event: HttpRequest): Promise<I> {
        const {httpMethod, queryStringParameters, body, pathParameters} = event;
        const decodedPathParameters = mapValues(pathParameters, (value) => {
            if (!value) {
                return value;
            }
            try {
                return decodeURIComponent(value);
            } catch (e) {
                throw new BadRequest(`Invalid URL component`);
            }
        });
        if (!includes(this.api.methods, httpMethod)) {
            throw new MethodNotAllowed(`Method ${httpMethod} is not allowed`);
        }
        let input = {...queryStringParameters, ...decodedPathParameters};
        if (body) {
            let payload;
            try {
                payload = JSON.parse(body);
            } catch (e) {
                throw new BadRequest(`Request payload is not valid JSON`);
            }
            if (!isObject(payload)) {
                throw new BadRequest(`Request payload is not a JSON object`);
            }
            input = {...input, ...payload};
        }
        const validationErrors: Array<{key: string, message: string}> = [];
        const validatedInput: {[key: string]: any} = {};
        forEach(this.api.params, (field: Field<any>, name) => {
            try {
                validatedInput[name] = field.deserialize(input[name]);
            } catch (error) {
                if (error.invalid) {
                    validationErrors.push({message: error.message, key: name});
                } else {
                    throw error;
                }
            }
        });
        if (validationErrors.length) {
            throw new BadRequest(`Invalid input`, {errors: validationErrors});
        }
        return validatedInput as I;
    }

    public execute(event: HttpRequest, context: HttpRequestContext, callback: HttpCallback) {
        this.executeHandler(event, context).then(
            (result) => callback(null, result),
            (error) => callback(error),
        );
    }

    private async executeHandler(event: HttpRequest, context: HttpRequestContext) {
        const input = await this.deserialize(event);
        try {
            return this.convertApiResponse(await this.run(input, event, context));
        } catch (error) {
            // Determine if the error was a HTTP response
            const {statusCode, body, data, headers} = error || {} as any;
            if (isNumber(statusCode) && (data != null || isString(body)) && isObject(headers)) {
                // This was an intentional HTTP error, so it should be considered
                // a successful execution of the lambda function.
                return this.convertApiResponse(error);
            }
            // This doesn't seem like a HTTP response -> Pass through for the internal server error
            throw error;
        }
    }

    private convertApiResponse(response: ApiResponse<any> | HttpResponse): HttpResponse {
        const {statusCode, data, body, headers} = response as ApiResponse<any> & HttpResponse;
        const encodedBody = body == null ? data === undefined ? '' : JSON.stringify(data) : body;
        return {
            statusCode,
            body: encodedBody,
            headers: {
                'Access-Control-Allow-Origin': __SITE_ORIGIN__,
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
                'Access-Control-Allow-Credentials': 'true',
                'Content-Type': 'application/json',
                'Content-Length': String(encodedBody.length),
                ...headers,
            },
        };
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
                throw new BadRequest(`Cannot perform ${httpMethod} as ${method} request`);
            }
        }
        // Return with possible changed HTTP method
        return { ...request, httpMethod };
    }
}
