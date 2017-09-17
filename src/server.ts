import * as http from 'http';
import * as path from 'path';
import { Observable } from 'rxjs';
import { URL } from 'url';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import { IAppConfig } from './config';
import { ApiRequestHandler } from './endpoints';
import { HttpMethod, IHttpRequest, IHttpRequestContext, IHttpResponse } from './http';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';
import isFunction = require('lodash/isFunction');

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
    // TODO
    const compiler = webpack(getBackendWebpackConfig({...options, debug: true, devServer: true}));
    return new Observable<webpack.Stats>((subscriber) => {
        const watching = compiler.watch({
            aggregateTimeout: 300,
            poll: 5000,
        }, (error, stats) => {
            if (error) {
                subscriber.error(error);
            } else {
                subscriber.next(stats);
            }
        });
        return () => watching.close(() => undefined);
    })
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
        const statsJson = stats.toJson();
        const apiRequestHandlerFileName = statsJson.assetsByChunkName._api[0];
        const apiRequestHandlerFilePath = path.resolve(options.projectRoot, options.buildDir, apiRequestHandlerFileName);
        // Ensure that module will be re-loaded
        delete require.cache[apiRequestHandlerFilePath];
        const handler: ApiRequestHandler<any> = require(apiRequestHandlerFilePath);
        if (!handler || !isFunction(handler.request)) {
            throw new Error(`The exported API module must have a 'request' callable!`);
        }
        return serveHttp$(serverPort, (httpRequest, httpResponse) => {
            const context: IHttpRequestContext = {
                accountId: '', // TODO
                resourceId: '', // TODO
                stage: '', // TODO
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
                resourcePath: '', // TODO
                httpMethod: httpRequest.method as HttpMethod, // TODO
                apiId: '', // TODO
            };
            const request: IHttpRequest = {
                resource: '', // TODO
                httpMethod: httpRequest.method as HttpMethod,
                path: httpRequest.url as string, // TODO: Remove GET parameters
                queryStringParameters: {}, // TODO
                pathParameters: {}, // TODO
                headers: httpRequest.headers as any, // TODO: String values?
                stageVariables: {}, // TODO
                requestContext: context,
            };
            handler.request(request, context, (error?: Error | null, response?: IHttpResponse | null) => {
                if (error) {
                    // tslint:disable-next-line:no-console
                    console.error(`${request.httpMethod} ${request.path} => 500\n${error}`);
                    httpResponse.writeHead(500, {
                        'Content-Type': 'text/plain',
                    });
                    httpResponse.end(`Internal server error:\n${error}`);
                } else if (response) {
                    // tslint:disable-next-line:no-console
                    console.log(`${request.httpMethod} ${request.path} => ${response.statusCode}`);
                    httpResponse.writeHead(response.statusCode, response.headers);
                    httpResponse.end(response.body);
                }
            });
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
