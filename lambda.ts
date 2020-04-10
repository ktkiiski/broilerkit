import transform from 'immuton/transform';
import { HttpMethod, HttpRequest, HttpRequestHeaders, HttpResponse, HttpStatus } from './http';

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
    authorizer?: {
        claims?: {
            'aud': string;
            'cognito:groups': string;
            'cognito:username': string;
            'email': string;
            'exp': string;
            'iat': string;
            'identities': string;
            'iss': string;
            'name': string;
            'sub': string;
            'picture': string | null;
            'token_use': string;
        };
    };
}

export interface LambdaHttpRequest {
    resource: string;
    httpMethod: HttpMethod;
    path: string;
    queryStringParameters: {[parameter: string]: string};
    pathParameters: {[parameter: string]: string};
    headers: HttpRequestHeaders;
    stageVariables: {[variable: string]: string} | void;
    requestContext: LambdaHttpRequestContext;
    body?: string;
    isBase64Encoded?: boolean;
}

export interface LambdaHttpResponse {
    statusCode: HttpStatus;
    multiValueHeaders: { [header: string]: string[] };
    isBase64Encoded: boolean;
    body: string;
}

export type LambdaHttpHandler = (request: LambdaHttpRequest, context: LambdaHttpRequestContext) => Promise<LambdaHttpResponse>;

export function lambdaMiddleware<P extends any[]>(handler: (request: HttpRequest, ...params: P) => Promise<HttpResponse>): (request: LambdaHttpRequest, ...params: P) => Promise<LambdaHttpResponse> {
    async function handleLambdaRequest(lambdaRequest: LambdaHttpRequest, ...params: P): Promise<LambdaHttpResponse> {
        const { httpMethod, isBase64Encoded, body } = lambdaRequest;
        const queryParameters = lambdaRequest.queryStringParameters || {};
        const headers = lambdaRequest.headers || {};
        const bodyBuffer = body == null ? body : Buffer.from(
            body, isBase64Encoded ? 'base64' : 'utf8',
        );
        const environment = lambdaRequest.stageVariables || {};
        const region = environment.Region;
        if (!region) {
            throw new Error(`The Region stage variable is missing!`);
        }
        const serverOrigin = environment.ServerOrigin;
        if (!serverOrigin) {
            throw new Error(`The ServerOrigin stage variable is missing!`);
        }
        const serverRoot = environment.ServerRoot;
        if (!serverRoot) {
            throw new Error(`The ServerRoot stage variable is missing!`);
        }
        const request = {
            method: httpMethod,
            path: lambdaRequest.path,
            queryParameters, headers,
            body: bodyBuffer,
            environment, region,
            serverRoot,
            serverOrigin,
            // Auth will be set by another middleware
            auth: null,
            // Read the directory path from environment variables
            // directoryPath: process.env.LAMBDA_TASK_ROOT as string,
        };
        const response = await handler(request, ...params);
        const responseHeaders = transform(response.headers, (headerValue) => (
            Array.isArray(headerValue) ? headerValue : [headerValue]
        ));
        return {
            statusCode: response.statusCode,
            multiValueHeaders: responseHeaders,
            isBase64Encoded: false,
            body: response.body,
        };
    }
    return handleLambdaRequest;
}

export interface LambdaS3Event {
    Records: Array<{
        eventName: string;
        eventTime: string;
        s3: {
            bucket: {
                name: string;
                // arn: string;
            };
            object: {
                key: string;
                size: number;
                // eTag: string;
                // versionId: string | null;
                // sequencer?: string | null;
            };
        };
    }>;
}
export type LambdaEvent = LambdaS3Event;
export type LambdaEventHandler = (event: LambdaEvent) => Promise<void>;
