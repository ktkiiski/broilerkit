import { bold, cyan, green, red, yellow } from 'chalk';
import * as http from 'http';
import * as path from 'path';
import { Observable } from 'rxjs';
import { URL } from 'url';
import * as url from 'url';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import { watch$ } from './compile';
import { IAppConfig } from './config';
import { ApiRequestHandler, IApiEndpoint } from './endpoints';
import { HttpMethod, HttpStatus, IHttpRequest, IHttpRequestContext, IHttpResponse } from './http';
import { readStream } from './node';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';
import isFunction = require('lodash/isFunction');
import includes = require('lodash/includes');
import flatten = require('lodash/flatten');
import filter = require('lodash/filter');
import map = require('lodash/map');

/**
 * Runs the Webpack development server.
 */
export function serve$(options: IAppConfig): Observable<IAppConfig> {
    const assetsOriginUrl = new URL(options.siteOrigin);
    const assetsProtocol = assetsOriginUrl.protocol;
    const siteOriginUrl = new URL(options.siteOrigin);
    const siteProtocol = siteOriginUrl.protocol;
    const serverPort = parseInt(siteOriginUrl.port, 10);
    const enableHttps = assetsProtocol === 'https:' || siteProtocol === 'https:';
    // TODO: Is this configuration for the inline livereloading still required?
    // https://webpack.github.io/docs/webpack-dev-server.html#inline-mode-with-node-js-api
    return Observable.of({...options, debug: true, devServer: true})
        .map((config) => webpack(getFrontendWebpackConfig(config)))
        .map((compiler) => new WebpackDevServer(compiler, {
            allowedHosts: [
                assetsOriginUrl.hostname,
                siteOriginUrl.hostname,
            ],
            https: enableHttps,
            stats: {
                colors: true,
            },
            watchOptions: {
                poll: 1000,
            },
            publicPath: '/',
        } as WebpackDevServer.Configuration))
        .switchMap((devServer) => new Observable((subscriber) => {
            const server = devServer.listen(serverPort, (error) => {
                if (error) {
                    subscriber.error(error);
                } else {
                    subscriber.next(options);
                }
            });
            server.on('close', () => subscriber.complete());
            server.on('error', (error) => subscriber.error(error));
        }))
    ;
}

/**
 * Runs the REST API development server.
 */
export function serveApi$(options: IAppConfig) {
    const {apiOrigin} = options;
    const apiOriginUrl = new URL(apiOrigin);
    const apiProtocol = apiOriginUrl.protocol;
    const serverPort = parseInt(apiOriginUrl.port, 10);
    const enableHttps = apiProtocol === 'https:';
    if (enableHttps) {
        throw new Error(`HTTPS is not yet supported on the local REST API server! Switch to use ${apiOrigin.replace(/^https/, 'http')} instead!`);
    }
    return watch$(getBackendWebpackConfig({...options, debug: true, devServer: true}))
    .filter((stats) => {
        if (stats.hasErrors()) {
            // tslint:disable-next-line:no-console
            console.error(stats.toString({
                chunks: false,  // Makes the build much quieter
                colors: true,    // Shows colors in the console
            }));
            return false;
        }
        return true;
    })
    .switchMap((stats) => {
        // tslint:disable-next-line:no-console
        console.log(stats.toString('minimal'));

        const statsJson = stats.toJson();
        const apiRequestHandlerFileName = statsJson.assetsByChunkName._api[0];
        const apiRequestHandlerFilePath = path.resolve(options.projectRoot, options.buildDir, apiRequestHandlerFileName);
        // Ensure that module will be re-loaded
        delete require.cache[apiRequestHandlerFilePath];
        const handler: ApiRequestHandler<{[endpoint: string]: IApiEndpoint<any>}> = require(apiRequestHandlerFilePath);
        if (!handler || !isFunction(handler.request)) {
            throw new Error(`The exported API module must have a 'request' callable!`);
        }
        return serveHttp$(serverPort, (httpRequest, httpResponse) => {
            // Find a matching endpoint
            const {endpoints} = handler;
            let endpointName: string | null = null;
            let pathParameters: {[key: string]: string} | null = null;
            let resource: string | null = null;
            // Find a matching endpoint
            for (const name in endpoints) {
                if (endpoints.hasOwnProperty(name)) {
                    const {api} = endpoints[name];
                    pathParameters = api.parseUrl(httpRequest.url as string);
                    if (pathParameters) {
                        if (httpRequest.method === 'OPTIONS') {
                            // Respond with CORS headers
                            const allowedMethods = flatten(
                                map(
                                    filter(handler.endpoints, (endpoint) => endpoint.api.url === api.url),
                                    (endpoint) => endpoint.api.methods,
                                ),
                            );
                            httpResponse.writeHead(200, {
                                'Access-Control-Allow-Origin': options.siteOrigin,
                                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
                                'Access-Control-Allow-Methods': allowedMethods.join(','),
                                'Access-Control-Allow-Credentials': 'true',
                            });
                            httpResponse.end();
                            return;
                        } else if (includes(api.methods, httpRequest.method)) {
                            endpointName = name;
                            resource = api.url;
                            break;
                        }
                    }
                }
            }
            if (!resource || !pathParameters) {
                httpResponse.writeHead(404, {'Content-Type': 'text/plain'});
                httpResponse.end(`Not Found`);
                return;
            }
            nodeRequestToLambdaRequest(httpRequest, resource, pathParameters)
                .switchMap((request) => new Observable<IHttpResponse>((subscriber) => {
                    handler.request(request, request.requestContext, (error?: Error | null, response?: IHttpResponse | null) => {
                        if (error) {
                            subscriber.error(error);
                        } else if (response) {
                            subscriber.next(response);
                            subscriber.complete();
                        } else {
                            subscriber.complete();
                        }
                    });
                }))
                .single()
                .subscribe({
                    next: (response) => {
                        // tslint:disable-next-line:no-console
                        console.log(`${httpRequest.method} ${httpRequest.url} → ${bold(endpointName as string)} → ${colorizeStatusCode(response.statusCode)}`);
                        httpResponse.writeHead(response.statusCode, response.headers);
                        httpResponse.end(response.body);
                    },
                    error: (error) => {
                        // tslint:disable-next-line:no-console
                        console.error(`${httpRequest.method} ${httpRequest.url} → ${bold(endpointName as string)} → ${colorizeStatusCode(500)}\n${error}`);
                        httpResponse.writeHead(500, {
                            'Content-Type': 'text/plain',
                        });
                        httpResponse.end(`Internal server error:\n${error}`);
                    },
                })
            ;
        });
    });
}

function serveHttp$(port: number, requestListener: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
    return new Observable(() => {
        const server = http.createServer(requestListener);
        server.listen(port);
        return () => server.close();
    });
}

function nodeRequestToLambdaRequest(request: http.IncomingMessage, resource: string, pathParameters: {[parameter: string]: string}): Observable<IHttpRequest> {
    const requestUrlObj = url.parse(request.url as string, true);
    const context: IHttpRequestContext = {
        accountId: '', // TODO
        resourceId: '', // TODO
        stage: 'api',
        requestId: '', // TODO
        identity: {
            cognitoIdentityPoolId: '', // TODO
            accountId: '', // TODO
            cognitoIdentityId: '', // TODO
            caller: '', // TODO
            apiKey: '', // TODO
            sourceIp: '', // TODO
            cognitoAuthenticationType: '', // TODO
            cognitoAuthenticationProvider: '', // TODO
            userArn: '', // TODO
            userAgent: '', // TODO
            user: '', // TODO
        },
        resourcePath: resource,
        httpMethod: request.method as HttpMethod, // TODO
        apiId: '', // TODO
    };
    const baseRequest = {
        resource,
        pathParameters,
        httpMethod: request.method as HttpMethod,
        path: requestUrlObj.pathname as string,
        queryStringParameters: requestUrlObj.search ? requestUrlObj.query : undefined,
        headers: request.headers as any, // TODO: String values?
        stageVariables: {}, // TODO
        requestContext: context,
    };
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
        return Observable.of(baseRequest);
    }
    return readStream(request).map((body) => ({
        ...baseRequest, body, isBase64Encoded: false,
    }));
}

function colorizeStatusCode(statusCode: HttpStatus): string {
    const codeStr = String(statusCode);
    if (statusCode >= 200 && statusCode < 300) {
        return green(codeStr);
    } else if (statusCode >= 300 && statusCode < 400) {
        return cyan(codeStr);
    } else if (statusCode >= 400 && statusCode < 500) {
        return yellow(codeStr);
    } else if (statusCode >= 500 && statusCode < 600) {
        return red(codeStr);
    }
    return codeStr;
}
