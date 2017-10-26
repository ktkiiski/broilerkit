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

export interface HttpRequest {
    /**
     * URL path of the request, starting with a leading trail.
     */
    path: string;
    /**
     * URL path pattern for the matching endpoint.
     */
    endpoint: string;
    /**
     * Mapping of endpoint parameters in the URL path.
     */
    endpointParameters: {
        [parameter: string]: string;
    };
    /**
     * HTTP method that was used. If the HTTP method switch was used with query
     * parameters, then this is the switched HTTP method.
     */
    method: HttpMethod;
    /**
     * Body of the request, or undefined if the HTTP method was either
     * HEAD, GET, OPTIONS or DELETE.
     */
    body?: string;
    /**
     * HTTP headers as an object.
     */
    headers: HttpHeaders;
    /**
     * Query parameters parsed from the URL.
     * This is an empty object if the URL did not contain any query.
     */
    queryParameters: {
        [parameter: string]: string;
    };
}

export interface HttpResponse {
    statusCode: HttpStatus;
    headers: HttpHeaders;
    body: string;
}

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
    public readonly data: any;
    constructor(message: string, data?: object, public readonly headers: HttpHeaders = {}) {
        super(message);
        this.data = {...data, message};
    }
}

export class OK<T> extends SuccesfulResponse<T> {
    public readonly statusCode = HttpStatus.OK;
}

export class Created<T> extends SuccesfulResponse<T> {
    public readonly statusCode = HttpStatus.Created;
}

export class NoContent extends SuccesfulResponse<void> {
    public readonly statusCode = HttpStatus.NoContent;
    constructor(headers?: HttpHeaders) {
        super(undefined, headers);
    }
}

export class NotFound extends ExceptionResponse {
    public readonly statusCode = HttpStatus.NotFound;
}

export class BadRequest extends ExceptionResponse {
    public readonly statusCode = HttpStatus.BadRequest;
}

export class MethodNotAllowed extends ExceptionResponse {
    public readonly statusCode = HttpStatus.MethodNotAllowed;
}
