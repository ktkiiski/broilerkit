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

/**
 * Any supported HTTP method.
 */
export type HttpMethod = 'HEAD' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface IHttpHeaders {
    [header: string]: string;
}

export interface IHttpResponse {
    statusCode: HttpStatus;
    headers: IHttpHeaders;
    body: string;
}

export interface ILambdaCallback<R> {
    (error: null | undefined, result: R): void;
    (error: Error, result?: null): void;
}

export type HttpCallback = ILambdaCallback<IHttpResponse>;

export interface IHttpRequestContext {
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

export interface IHttpRequest {
    resource: string;
    httpMethod: HttpMethod;
    path: string;
    queryStringParameters: {[parameter: string]: string};
    pathParameters: {[parameter: string]: string};
    headers: IHttpHeaders;
    stageVariables: {[variable: string]: string};
    requestContext: IHttpRequestContext;
    body?: string;
    isBase64Encoded?: boolean;
}

export function isReadHttpMethod(method: string): method is 'GET' | 'HEAD' {
    return method === 'GET' || method === 'HEAD';
}

export function isWriteHttpMethod(method: string): method is 'POST' | 'PUT' | 'PATCH' | 'DELETE' {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}
