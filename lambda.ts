import { HttpHeaders, HttpMethod, HttpResponse } from './http';
import { requestMiddleware } from './middleware';

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
    headers: HttpHeaders;
    stageVariables: {[variable: string]: string} | void;
    requestContext: LambdaHttpRequestContext;
    body?: string;
    isBase64Encoded?: boolean;
}

export type LambdaHttpHandler = (request: LambdaHttpRequest, _: any, callback: LambdaCallback) => void;

export const lambdaMiddleware = requestMiddleware(async (request: LambdaHttpRequest) => {
    const {httpMethod, isBase64Encoded, requestContext} = request;
    const queryParameters = request.queryStringParameters || {};
    const headers = request.headers || {};
    const authorizer = requestContext && requestContext.authorizer;
    const claims = authorizer && authorizer.claims || null;
    const groupsStr = claims && claims['cognito:groups'];
    const auth = claims && {
        id: claims.sub,
        name: claims.name,
        email: claims.email,
        picture: claims.picture || null,
        groups: groupsStr ? groupsStr.split(',') : [],
    };
    const body = isBase64Encoded && request.body
        // Decode base64 encoded body
        ? Buffer.from(request.body, 'base64').toString()
        : request.body
    ;
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
        queryParameters, headers, body,
        environment, region,
        apiRoot, siteRoot,
        apiOrigin, siteOrigin,
        auth,
        // Read the directory path from environment variables
        // directoryPath: process.env.LAMBDA_TASK_ROOT as string,
    };
});
