import { BadRequest, HttpHeaders, HttpMethod, HttpRequest, HttpResponse, isReadHttpMethod, isWriteHttpMethod, UnsupportedMediaType } from './http';

export type LambdaHttpResponse = HttpResponse;

export interface LambdaCallback {
    (error: null | undefined, result: LambdaHttpResponse): void;
    (error: Error, result?: null): void;
}

export interface LambdaHttpRequestContext {
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

export interface LambdaHttpRequest {
    resource: string;
    httpMethod: HttpMethod;
    path: string;
    queryStringParameters: {[parameter: string]: string};
    pathParameters: {[parameter: string]: string};
    headers: HttpHeaders;
    stageVariables: {[variable: string]: string} | void;
    requestContext: LambdaHttpRequestContext;
    body?: string;
    isBase64Encoded?: boolean;
}

export type LambdaHttpHandler = (request: LambdaHttpRequest, context: LambdaHttpRequestContext, callback: LambdaCallback) => void;

export function convertLambdaRequest(request: LambdaHttpRequest, _: LambdaHttpRequestContext): HttpRequest {
    let {httpMethod} = request;
    const {body, isBase64Encoded} = request;
    const queryParameters = request.queryStringParameters || {};
    const headers = request.headers || {};
    const {method = null} = queryParameters;
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
    // Parse the request payload as JSON
    const contentType = headers['Content-Type'];
    if (contentType && contentType !== 'application/json') {
        throw new UnsupportedMediaType(`Only application/json is accepted`);
    }
    let payload: any;
    if (body) {
        try {
            const encodedBody = isBase64Encoded ? Buffer.from(body, 'base64').toString() : body;
            payload = JSON.parse(encodedBody);
        } catch {
            throw new BadRequest(`Invalid JSON payload`);
        }
    }
    const environment = request.stageVariables || {};
    const region = environment.Region;
    if (!region) {
        throw new Error(`The Region stage variable is missing!`);
    }
    const apiOrigin = environment.ApiOrigin;
    if (!apiOrigin) {
        throw new Error(`The ApiOrigin stage variable is missing!`);
    }
    const apiRoot = environment.ApiRoot;
    if (!apiRoot) {
        throw new Error(`The ApiRoot stage variable is missing!`);
    }
    const siteOrigin = environment.SiteOrigin;
    if (!siteOrigin) {
        throw new Error(`The SiteOrigin stage variable is missing!`);
    }
    const siteRoot = environment.SiteRoot;
    if (!siteRoot) {
        throw new Error(`The SiteRoot stage variable is missing!`);
    }
    return {
        method: httpMethod,
        path: request.path,
        queryParameters, headers, body, payload,
        environment, region,
        apiRoot, siteRoot,
        apiOrigin, siteOrigin,
        // Read the directory path from environment variables
        // directoryPath: process.env.LAMBDA_TASK_ROOT as string,
    };
}
