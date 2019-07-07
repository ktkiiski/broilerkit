import { transformKeys } from './utils/objects';
import { capitalize, splitOnce } from './utils/strings';

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
    NotModified = 304,
    // Client errors
    BadRequest = 400,
    Unauthorized = 401,
    PaymentRequired = 402,
    Forbidden = 403,
    NotFound = 404,
    MethodNotAllowed = 405,
    NotAcceptable = 406,
    RequestTimeout = 408,
    Conflict = 409,
    Gone = 410,
    PreconditionFailed = 412,
    UnsupportedMediaType = 415,
    TooManyRequests = 429,
    // Server-side errors
    InternalServerError = 500,
    NotImplemented = 501,
    BadGateway = 502,
    ServiceUnavailable = 503,
    GatewayTimeout = 504,
}

export type HttpSuccessStatus = 200 | 201 | 202 | 204;
export type HttpRedirectStatus = 301 | 302;
export type HttpClientErrorStatus = 400 | 401 | 402 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 415 | 429;
export type HttpServerErrorStatus = 500 | 501 | 502 | 503 | 504;
export type HttpErrorStatus = HttpClientErrorStatus | HttpServerErrorStatus;

/**
 * Any supported HTTP method.
 */
export type HttpMethod = 'HEAD' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface HttpHeaders {
    [header: string]: string;
}

export interface HttpAuth {
    id: string;
    email: string;
    name: string;
    picture: string | null;
    groups: string[];
}

export interface HttpRequest {
    /**
     * URL path of the request, starting with a leading trail.
     */
    path: string;
    /**
     * HTTP method that was used. If the HTTP method switch was used with query
     * parameters, then this is the switched HTTP method.
     */
    method: HttpMethod;
    /**
     * Raw, unparsed body of the request, or undefined if the HTTP method was either
     * HEAD, GET, OPTIONS or DELETE.
     */
    body?: string;
    /**
     * HTTP headers as an object.
     */
    headers: HttpHeaders;
    /**
     * Query parameters parsed from the URL. This is an empty object if
     * the URL did not contain any query. URL decoding has been already made
     * to every value.
     */
    queryParameters: {
        [parameter: string]: string;
    };
    /**
     * The root URL of the server from which the requests
     * are expected to become. This does not include any trailing slash.
     */
    serverRoot: string;
    /**
     * The origin of the server from which the requests
     * are expected to become, including the protocol, host and any port number.
     * This does not include any trailing slash.
     */
    serverOrigin: string;
    /**
     * Region in which the request is being executed.
     */
    region: string; // TODO: Literal typing for the region
    /**
     * Environment or staging variables about the server on which
     * the request is being executed.
     */
    environment: {
        [variable: string]: string;
    };
    /**
     * User that has been authenticated for the request, containing basic the
     * information stored to the access or identity token.
     */
    auth: HttpAuth | null;
}

export interface AuthenticatedHttpRequest extends HttpRequest {
    auth: HttpAuth;
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
 * Unlike in HttpResponse, the data should be a response object
 * that is not yet encoded as JSON string.
 */
export interface ApiResponse<T = any> {
    readonly statusCode: HttpStatus;
    readonly data?: T;
    readonly headers: HttpHeaders;
}

export abstract class SuccesfulResponse<T> implements ApiResponse<T> {
    public readonly abstract statusCode: HttpSuccessStatus;
    constructor(public readonly data: T, public readonly headers: HttpHeaders = {}) {}
}

export abstract class ExceptionResponse extends Error implements ApiResponse {
    public readonly abstract statusCode: HttpRedirectStatus | HttpErrorStatus;
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

export class Unauthorized extends ExceptionResponse {
    public readonly statusCode = HttpStatus.Unauthorized;
}

export class BadRequest extends ExceptionResponse {
    public readonly statusCode = HttpStatus.BadRequest;
}

export class MethodNotAllowed extends ExceptionResponse {
    public readonly statusCode = HttpStatus.MethodNotAllowed;
}

export class Conflict extends ExceptionResponse {
    public readonly statusCode = HttpStatus.Conflict;
}

export class PreconditionFailed extends ExceptionResponse {
    public readonly statusCode = HttpStatus.PreconditionFailed;
}

export class UnsupportedMediaType extends ExceptionResponse {
    public readonly statusCode = HttpStatus.UnsupportedMediaType;
}

export class NotImplemented extends ExceptionResponse {
    public readonly statusCode = HttpStatus.NotImplemented;
}

export class Redirect extends Error implements ApiResponse<null> {
    public readonly headers = { Location: this.url };
    public readonly data = null;
    constructor(
        public readonly url: string,
        public readonly statusCode: HttpStatus.Found | HttpStatus.MovedPermanently = HttpStatus.Found,
    ) {
        super(`Redirect to ${url}`);
    }
}

export function isApiResponse(response: any, statusCode?: HttpStatus): response is ApiResponse {
    return isResponse(response, statusCode) && !('body' in response);
}

export function isResponse(response: any, statusCode?: HttpStatus): response is HttpResponse | ApiResponse {
    if (!response) {
        return false;
    }
    const {statusCode: responseStatusCode} = response;
    return typeof responseStatusCode === 'number'
        && !isNaN(responseStatusCode)
        && typeof response.headers === 'object'
        && (typeof response.body === 'string' || typeof response.data !== 'undefined')
        && (statusCode == null || responseStatusCode === statusCode)
    ;
}

export function isErrorResponse(response: any, statusCode?: HttpErrorStatus): response is ApiResponse {
    return isApiResponse(response, statusCode) && response.statusCode >= 400;
}

export function acceptsContentType(request: HttpRequest, contentType: string): boolean {
    const splittedContentType = contentType.split('/');
    const type = splittedContentType[0].toLowerCase();
    const subType = splittedContentType[1].toLowerCase();
    const {headers} = request;
    const acceptHeader = headers && headers.Accept;
    if (!acceptHeader) {
        // No Accept header available
        return false;
    }
    const acceptedMimes = acceptHeader.toLowerCase().split(/\s*,\s*/g);
    for (const acceptedMime of acceptedMimes) {
        const match = /^(\w+)\/(\w+)/.exec(acceptedMime);
        if (match && match[1] === type && (match[2] === subType || match[2] === '*')) {
            return true;
        }
    }
    return false;
}

export function parseHeaders(headersString: string) {
    const headers: Record<string, string> = {};
    for (const headerLine of headersString.split('\r\n')) {
        const headerMatch = /^(.+?):\s*(.*)$/.exec(headerLine);
        if (headerMatch) {
            headers[headerMatch[1]] = headerMatch[2];
        }
    }
    return normalizeHeaders(headers);
}

export function normalizeHeaders(headers: HttpHeaders): HttpHeaders {
    return transformKeys(headers, (header) => (
        header.replace(/(\w+)/g, (match) => capitalize(match))
    ));
}

export function parseHeaderDirectives(header: string): [string, Record<string, string>] {
    const [directive, ...parts] = header.split(/\s*;\s*/g);
    const meta: Record<string, string> = {};
    for (const part of parts) {
        let [key, value] = splitOnce(part, '=');
        key = key.trim();
        if (key) {
            value = (value || '').trim();
            if (/^".*"$/.test(value)) {
                try {
                    value = JSON.parse(value) as string;
                } catch {
                    value = value.slice(1, -1);
                }
            }
            meta[key] = value;
        }
    }
    return [directive, meta];
}
