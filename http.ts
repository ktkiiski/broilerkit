/**
 * All supported HTTP status codes.
 */
export const enum HttpStatus {
    // Successful
    OK = 200,
    Created = 201,
    Accepted = 202,
    NoContent = 204,
    // Redirections
    MovedPermanently = 301,
    Found = 302,
    // Client errors
    BadRequest = 400,
    Unauthorized = 401,
    PaymentRequired = 402,
    Forbidden = 403,
    NotFound = 404,
    MethodNotAllowed = 405,
    NotAcceptable = 406,
    Conflict = 409,
    Gone = 410,
}

export type HttpSuccessStatus = 200 | 201 | 202 | 204;
export type HttpRedirectStatus = 301 | 302;
export type HttpClientErrorStatus = 400 | 401 | 402 | 403 | 404 | 405 | 406 | 409 | 410;

/**
 * Any supported HTTP method.
 */
export type HttpMethod = 'HEAD' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface HttpHeaders {
    [header: string]: string;
}

export interface HttpResponse {
    statusCode: HttpStatus;
    headers: HttpHeaders;
    body: string;
}

export interface LambdaCallback<R> {
    (error: null | undefined, result: R): void;
    (error: Error, result?: null): void;
}

export type HttpCallback = LambdaCallback<HttpResponse>;

export interface HttpRequestContext {
    accountId: string;
    resourceId: string;
    stage: string;
    requestId: string;
    identity: {
        cognitoIdentityPoolId: string;
        accountId: string;
        cognitoIdentityId: string;
        caller: string;
        apiKey: string;
        sourceIp: string;
        cognitoAuthenticationType: string;
        cognitoAuthenticationProvider: string;
        userArn: string;
        userAgent: string;
        user: string;
    };
    resourcePath: string;
    httpMethod: string;
    apiId: string;
}

export interface HttpRequest {
    resource: string;
    httpMethod: HttpMethod;
    path: string;
    queryStringParameters: {[parameter: string]: string};
    pathParameters: {[parameter: string]: string};
    headers: HttpHeaders;
    stageVariables: {[variable: string]: string};
    requestContext: HttpRequestContext;
    body?: string;
    isBase64Encoded?: boolean;
}

export type HttpHandler = (request: HttpRequest, context: HttpRequestContext, callback: HttpCallback) => void;

export function isReadHttpMethod(method: string): method is 'GET' | 'HEAD' {
    return method === 'GET' || method === 'HEAD';
}

export function isWriteHttpMethod(method: string): method is 'POST' | 'PUT' | 'PATCH' | 'DELETE' {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/**
 * Represents a response from an API endpoint function.
 * Unlike in IHttpResponse, the data should be a response object
 * that is not yet encoded as JSON string.
 */
export interface ApiResponse<T> {
    readonly statusCode: HttpStatus;
    readonly data?: T;
    readonly headers: HttpHeaders;
}

export abstract class SuccesfulResponse<T> implements ApiResponse<T> {
    public readonly abstract statusCode: HttpSuccessStatus;
    constructor(public readonly data: T, public readonly headers: HttpHeaders = {}) {}
}

export abstract class ExceptionResponse extends Error implements ApiResponse<any> {
    public readonly abstract statusCode: HttpRedirectStatus | HttpClientErrorStatus;
    constructor(message: string, public readonly data: any = {message}, public readonly headers: HttpHeaders = {}) {
        super(message);
    }
}

export class OK<T> extends SuccesfulResponse<T> {
    public readonly statusCode = HttpStatus.OK;
}

export class Created<T> extends SuccesfulResponse<T> {
    public readonly statusCode = HttpStatus.Created;
}

export class NotFound extends ExceptionResponse {
    public readonly statusCode = HttpStatus.NotFound;
}
