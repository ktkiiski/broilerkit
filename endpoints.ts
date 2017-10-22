import forEach = require('lodash/forEach');
import includes = require('lodash/includes');
import isNumber = require('lodash/isNumber');
import isObject = require('lodash/isObject');
import isString = require('lodash/isString');
import keys = require('lodash/keys');
import mapValues = require('lodash/mapValues');
import pick = require('lodash/pick');
import { DestroyApi, Endpoint, PayloadApi, RetrieveApi } from './api';
import { Field } from './fields';
import { BadRequest, MethodNotAllowed } from './http';
import { isReadHttpMethod, isWriteHttpMethod } from './http';
import { HttpCallback, HttpHandler, HttpResponse } from './http';
import { HttpRequest, HttpRequestContext } from './http';
import { ApiResponse, SuccesfulResponse } from './http';

declare const __SITE_ORIGIN__: string;

export type ApiFunctionHandler<I, P, O> = (identifier: I, payload: P, event: HttpRequest, context: HttpRequestContext) => Promise<SuccesfulResponse<O>>;

export interface IPage<T> {
    next: string | null;
    results: T[];
}

export interface ApiFunction<IE, II, PE, PI, OE, OI, RI, RE> {
    (request: HttpRequest, context: HttpRequestContext): Promise<HttpResponse>;
    endpoint: Endpoint<IE, II, PE, PI, OE, OI, RI, RE>;
}
export type GenericApiFunction = ApiFunction<any, any, any, any, any, any, any, any>;

export function implement<IE, II>(endpoint: DestroyApi<IE, II>, handler: ApiFunctionHandler<II, void, void>): ApiFunction<IE, II, void, void, void, void, void, void>;
export function implement<IE, II, RI, RE>(endpoint: RetrieveApi<IE, II, RI, RE>, handler: ApiFunctionHandler<II, void, RI>): ApiFunction<IE, II, void, void, void, void, RI, RE>;
export function implement<IE, II, PE, PI, OE, OI, RI, RE>(endpoint: PayloadApi<IE, II, PE, PI, OE, OI, RI, RE>, handler: ApiFunctionHandler<II, PI & Partial<OI>, RI>): ApiFunction<IE, II, PE, PI, OE, OI, RI, RE>;
export function implement<IE, II, PE, PI, OE, OI, RI, RE>(endpoint: Endpoint<IE, II, PE, PI, OE, OI, RI, RE>, handler: ApiFunctionHandler<II, PI & Partial<OI>, RI>): ApiFunction<IE, II, PE, PI, OE, OI, RI, RE> {
    const { methods, identifier, requiredPayload, optionalPayload, attrs } = endpoint;

    async function execute(request: HttpRequest, context: HttpRequestContext) {
        const {httpMethod} = request;
        try {
            // Check that the API function was called with an accepted HTTP method
            if (!includes(methods, httpMethod)) {
                throw new MethodNotAllowed(`Method ${httpMethod} is not allowed`);
            }
            const input = await convertInput(request, {
                ...identifier as object,
                ...requiredPayload as object,
                ...optionalPayload as object,
            });
            const id = pick(input, keys(identifier)) as II;
            const payload = pick(input, keys(requiredPayload).concat(keys(optionalPayload))) as PI & Partial<OI>;
            const response = await handler(id, payload, request, context);
            if (!response.data) {
                return convertApiResponse(response);
            }
            const internalOutputData: any = response.data;
            const outputData: {[key: string]: any} = {};
            forEach(attrs, (field: Field<any, any>, name) => {
                outputData[name] = field.output(internalOutputData[name]);
            });
            return convertApiResponse({...response, data: outputData});
        } catch (error) {
            // Determine if the error was a HTTP response
            const {statusCode, body, data, headers} = error || {} as any;
            if (isNumber(statusCode) && (data != null || isString(body)) && isObject(headers)) {
                // This was an intentional HTTP error, so it should be considered
                // a successful execution of the lambda function.
                return convertApiResponse(error);
            }
            // This doesn't seem like a HTTP response -> Pass through for the internal server error
            throw error;
        }
    }
    return Object.assign(execute, { endpoint });
}

async function convertInput(event: HttpRequest, fields: {[name: string]: Field<any, any>}) {
    const {queryStringParameters, body, pathParameters} = event;
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
    forEach(fields, (field, name) => {
        try {
            validatedInput[name] = field.input(input[name]);
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
    return validatedInput as {[key: string]: any};
}

function convertApiResponse(response: ApiResponse<any> | HttpResponse): HttpResponse {
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

export class ApiRequestHandler {

    private readonly apiFunctionMapping: {[url: string]: GenericApiFunction};

    constructor(public readonly apiFunctions: {[endpoint: string]: GenericApiFunction}) {
        this.apiFunctionMapping = {};
        forEach(apiFunctions, (apiFunction) => {
            forEach(apiFunction.endpoint.methods, (method) => {
                this.apiFunctionMapping[`${method} ${apiFunction.endpoint.url}`] = apiFunction;
            });
        });
    }

    public request: HttpHandler = (request: HttpRequest, context: HttpRequestContext, callback: HttpCallback) => {
        request = this.normalizeRequest(request);
        const endpoint = this.apiFunctionMapping[`${request.httpMethod} ${request.resource}`];
        if (endpoint) {
            endpoint(request, context).then(
                (result) => callback(null, result),
                (error) => callback(error),
            );
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
