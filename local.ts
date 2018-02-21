import { cyan, green, red, yellow } from 'chalk';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';
import * as url from 'url';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import { watch } from './compile';
import { IAppConfig } from './config';
import { HttpHeaders, HttpMethod, HttpRequest, HttpStatus } from './http';
import { ApiService } from './server';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';

import isArray = require('lodash/isArray');
import isFunction = require('lodash/isFunction');
import mapValues = require('lodash/mapValues');
import { readStream } from './utils/fs';

/**
 * Runs the Webpack development server.
 */
export function serveFrontEnd(options: IAppConfig, onReady?: () => void): Promise<void> {
    const assetsOriginUrl = new URL(options.siteOrigin);
    const assetsProtocol = assetsOriginUrl.protocol;
    const siteOriginUrl = new URL(options.siteOrigin);
    const siteProtocol = siteOriginUrl.protocol;
    const serverPort = parseInt(siteOriginUrl.port, 10);
    const enableHttps = assetsProtocol === 'https:' || siteProtocol === 'https:';
    // TODO: Is this configuration for the inline livereloading still required?
    // https://webpack.github.io/docs/webpack-dev-server.html#inline-mode-with-node-js-api
    const compiler = webpack(getFrontendWebpackConfig({
        ...options, debug: true, devServer: true, analyze: false,
    }));
    const devServer = new WebpackDevServer(
        compiler,
        {
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
        } as WebpackDevServer.Configuration,
    );
    return new Promise((resolve, reject) => {
        const server = devServer.listen(serverPort, (error) => {
            if (error) {
                reject(error);
            } else if (onReady) {
                onReady();
            }
        });
        server.on('close', () => resolve());
        server.on('error', (error) => reject(error));
    });
}

/**
 * Runs the REST API development server.
 */
export async function serveBackEnd(options: IAppConfig) {
    const {apiOrigin} = options;
    const apiOriginUrl = new URL(apiOrigin);
    const apiProtocol = apiOriginUrl.protocol;
    const serverPort = parseInt(apiOriginUrl.port, 10);
    const enableHttps = apiProtocol === 'https:';
    if (enableHttps) {
        throw new Error(`HTTPS is not yet supported on the local REST API server! Switch to use ${apiOrigin.replace(/^https/, 'http')} instead!`);
    }
    const config = getBackendWebpackConfig({...options, debug: true, devServer: true, analyze: false});
    let server: http.Server | undefined;
    try {
        for await (const stats of watch(config)) {
            // Close any previously running server
            if (server) {
                server.close();
                server = undefined;
            }
            // Check for compilation errors
            if (stats.hasErrors()) {
                // tslint:disable-next-line:no-console
                console.error(stats.toString({
                    chunks: false,  // Makes the build much quieter
                    colors: true,    // Shows colors in the console
                }));
                continue;
            }
            // Successful compilation -> start the HTTP server
            // tslint:disable-next-line:no-console
            console.log(stats.toString('minimal'));

            const statsJson = stats.toJson();
            const apiRequestHandlerFileName = statsJson.assetsByChunkName._api[0];
            const apiRequestHandlerFilePath = path.resolve(options.projectRoot, options.buildDir, apiRequestHandlerFileName);
            // Ensure that module will be re-loaded
            delete require.cache[apiRequestHandlerFilePath];
            const handler: ApiService = require(apiRequestHandlerFilePath);
            if (!handler || !isFunction(handler.execute)) {
                // tslint:disable-next-line:no-console
                console.error(red(`The exported API module must have a 'execute' callable!`));
                continue;
            }
            // Start the server
            server = http.createServer(async (httpRequest, httpResponse) => {
                try {
                    const request = await nodeRequestToApiRequest(httpRequest);
                    const response = await handler.execute(request);
                    // tslint:disable-next-line:no-console
                    console.log(`${httpRequest.method} ${httpRequest.url} → ${colorizeStatusCode(response.statusCode)}`);
                    httpResponse.writeHead(response.statusCode, response.headers);
                    httpResponse.end(response.body);
                } catch (error) {
                    // tslint:disable-next-line:no-console
                    console.error(`${httpRequest.method} ${httpRequest.url} → ${colorizeStatusCode(500)}\n${error}`);
                    httpResponse.writeHead(500, {
                        'Content-Type': 'text/plain',
                    });
                    httpResponse.end(`Internal server error:\n${error}`);
                }
            });
            server.listen(serverPort);
        }
    } finally {
        if (server) {
            server.close();
        }
    }
}

async function nodeRequestToApiRequest(nodeRequest: http.IncomingMessage): Promise<HttpRequest> {
    const {method} = nodeRequest;
    const requestUrlObj = url.parse(nodeRequest.url as string, true);
    const origin = `${requestUrlObj.protocol}://${requestUrlObj.host}`;
    const request: HttpRequest = {
        origin,
        method: method as HttpMethod,
        path: requestUrlObj.pathname as string,
        queryParameters: mapValues(requestUrlObj.query, (values) => isArray(values) ? values[0] : values) as {[param: string]: string},
        headers: mapValues(nodeRequest.headers, (headers) => isArray(headers) ? headers[0] : headers) as HttpHeaders,
        region: 'local',
        environment: {}, // TODO
    };
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return request;
    }
    const chunks = await readStream(nodeRequest);
    return {...request, body: chunks.map((chunk) => chunk.toString()).join('')};
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
