import upperFirst = require('lodash');
import forEach = require('lodash/forEach');
import fromPairs = require('lodash/fromPairs');
import includes = require('lodash/includes');
import isNumber = require('lodash/isNumber');
import isObject = require('lodash/isObject');
import isString = require('lodash/isString');
import keys = require('lodash/keys');
import mapValues = require('lodash/mapValues');
import pick = require('lodash/pick');
import values = require('lodash/values');
import zip = require('lodash/zip');
import { DestroyApi, Endpoint, IApiListPage, ListApi, ListParams, PayloadApi, RetrieveApi } from './api';
import { Model, Table } from './db';
import { Field } from './fields';
import { BadRequest, MethodNotAllowed } from './http';
import { isReadHttpMethod, isWriteHttpMethod } from './http';
import { ApiResponse, HttpMethod, HttpRequest, HttpResponse, OK, SuccesfulResponse } from './http';
import { LambdaCallback, LambdaHttpHandler, LambdaHttpRequest, LambdaHttpRequestContext } from './lambda';

declare const __SITE_ORIGIN__: string;
declare const __AWS_REGION__: string;

export type ApiFunctionHandler<I, P, M, O> = (identifier: I, payload: P, models: M, request: HttpRequest) => Promise<SuccesfulResponse<O>>;

export interface ApiFunction<IE, II, PE, PI, OE, OI, RI, RE> {
    (request: HttpRequest): Promise<HttpResponse>;
    endpoint: Endpoint<IE, II, PE, PI, OE, OI, RI, RE>;
}
export type GenericApiFunction = ApiFunction<any, any, any, any, any, any, any, any>;
export interface Models {
    [name: string]: Model<any, any, any, any>;
}
export type Tables<T> = {
    [P in keyof T]: Table<T[P]>;
};

export function implementApi<M, IE, II>(endpoint: DestroyApi<IE, II>, db: Tables<M>, handler: ApiFunctionHandler<II, void, M, void>): ApiFunction<IE, II, void, void, void, void, void, void>;
export function implementApi<M, IE, II, RI, RE>(endpoint: RetrieveApi<IE, II, RI, RE>, db: Tables<M>, handler: ApiFunctionHandler<II, void, M, RI>): ApiFunction<IE, II, void, void, void, void, RI, RE>;
export function implementApi<M, IE, II, PE, PI, OE, OI, RI, RE>(endpoint: PayloadApi<IE, II, PE, PI, OE, OI, RI, RE>, db: Tables<M>, handler: ApiFunctionHandler<II, PI & Partial<OI>, M, RI>): ApiFunction<IE, II, PE, PI, OE, OI, RI, RE>;
export function implementApi<M, IE, II, PE, PI, OE, OI, RI, RE>(endpoint: Endpoint<IE, II, PE, PI, OE, OI, RI, RE>, db: Tables<M>, handler: ApiFunctionHandler<II, PI & Partial<OI>, M, RI>): ApiFunction<IE, II, PE, PI, OE, OI, RI, RE> {
    const { methods, identifier, requiredPayload, optionalPayload, attrs } = endpoint;

    async function execute(request: HttpRequest) {
        const {method} = request;
        const models = getModels(db, request);
        try {
            // Check that the API function was called with an accepted HTTP method
            if (!includes(methods, method)) {
                throw new MethodNotAllowed(`Method ${method} is not allowed`);
            }
            const input = await convertInput(request, {
                ...identifier as object,
                ...requiredPayload as object,
                ...optionalPayload as object,
            });
            const id = pick(input, keys(identifier)) as II;
            const payload = pick(input, keys(requiredPayload).concat(keys(optionalPayload))) as PI & Partial<OI>;
            const response = await handler(id, payload, models, request);
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

export function implementList<M, KE extends keyof RE, KI extends keyof RI, IE extends ListParams<KE, RE>, II extends ListParams<KI, RI>, RI, RE>(endpoint: ListApi<IE, II, RI, RE>, db: Tables<M>, handler: (identifier: II, models: M) => Promise<RI[]>): ApiFunction<IE, II, void, void, void, void, IApiListPage<RI>, IApiListPage<RE>> {
    async function list(identifier: II, _: any, models: M) {
        const {ordering} = identifier;
        const results = await handler(identifier, models);
        const {length} = results;
        if (!length) {
            return new OK({next: null, results});
        }
        const last = results[length - 1];
        const nextIdentifier = Object.assign({}, identifier, {
            since: last[ordering],
        });
        const nextUrl = endpoint.getUrl(nextIdentifier);
        return new OK({
            next: nextUrl,
            results,
        }, {
            Link: `${nextUrl}; rel="next"`,
        });
    }
    return implementApi<M, IE, II, IApiListPage<RI>, IApiListPage<RE>>(
        endpoint as RetrieveApi<IE, II, IApiListPage<RI>, IApiListPage<RE>>,
        db,
        list as ApiFunctionHandler<II, void, M, IApiListPage<RI>>,
    );
}

async function convertInput(request: HttpRequest, fields: {[name: string]: Field<any, any>}) {
    const {queryParameters, body, endpointParameters} = request;
    const decodedEndpointParameters = mapValues(endpointParameters, (value) => {
        if (!value) {
            return value;
        }
        try {
            return decodeURIComponent(value);
        } catch (e) {
            throw new BadRequest(`Invalid URL component`);
        }
    });
    let input = {...queryParameters, ...decodedEndpointParameters};
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
    const validationErrors: Array<{key: string, message: string, value: any}> = [];
    const validatedInput: {[key: string]: any} = {};
    forEach(fields, (field, name) => {
        const value = input[name];
        try {
            validatedInput[name] = field.input(value);
        } catch (error) {
            if (error.invalid) {
                validationErrors.push({message: error.message, key: name, value});
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

export class ApiService {

    constructor(
        public readonly apiFunctions: {[endpointName: string]: GenericApiFunction},
        public readonly dbTables: Tables<Models>,
    ) {}

    public async execute(request: HttpRequest): Promise<HttpResponse> {
        if (request.method === 'OPTIONS') {
            // Get all the methods supported by the endpoint
            const allowedMethods = new Array<HttpMethod>();
            this.matchEndpoints(request.path, (apiFunction) => {
                allowedMethods.push(...apiFunction.endpoint.methods);
            });
            // Respond with the CORS headers
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': __SITE_ORIGIN__,
                    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
                    'Access-Control-Allow-Methods': allowedMethods.join(','),
                    'Access-Control-Allow-Credentials': 'true',
                },
                body: '',
            };
        }
        // Otherwise find a matching endpoint that allows the given method, and execute it
        const execution = this.matchEndpoints(request.path, (apiFunction, pathParams) => {
            if (apiFunction.endpoint.methods.indexOf(request.method) >= 0) {
                return apiFunction({
                    ...request,
                    endpoint: apiFunction.endpoint.url,
                    endpointParameters: pathParams,
                });
            }
        });
        if (execution) {
            return await execution;
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

    public request: LambdaHttpHandler = (lambdaRequest: LambdaHttpRequest, context: LambdaHttpRequestContext, callback: LambdaCallback) => {
        const request = this.fromLambdaToApiRequest(lambdaRequest, context);
        this.execute(request).then(
            (result) => callback(null, result),
            (error) => callback(error),
        );
    }

    protected fromLambdaToApiRequest(request: LambdaHttpRequest, _: LambdaHttpRequestContext): HttpRequest {
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
        return {
            method: httpMethod,
            path: request.path,
            endpoint: request.resource,
            endpointParameters: request.pathParameters || {},
            queryParameters: request.queryStringParameters || {},
            headers: request.headers || {},
            body: request.body,
            environment: request.stageVariables || {},
            region: __AWS_REGION__,
        };
    }

    private matchEndpoints<T>(path: string, callback: (endpoint: GenericApiFunction, pathParameters: {[key: string]: string}) => T | void): T | undefined {
        for (const apiFunction of values(this.apiFunctions)) {
            const {urlRegexp, urlKeys} = apiFunction.endpoint;
            const match = urlRegexp.exec(path);
            if (match) {
                // TODO: Decode URI components
                const pathParameters = fromPairs(zip(urlKeys, match.slice(1)));
                const result = callback(apiFunction, pathParameters);
                if (result != null) {
                    return result;
                }
            }
        }
    }
}

function getModels<M>(db: Tables<M>, request: HttpRequest): M {
    return mapValues(
        db,
        (table: Table<any>) => {
            // TODO: Get this from a method/property of the table?
            const logicalId = `SimpleDBTable${upperFirst(table.name)}`;
            const domainName = request.environment[`${logicalId}DomainName`];
            return table.getModel(request.region, domainName);
        },
    ) as M;
}
