import { URL } from 'url';
import authLocalServer from './auth-local-server';
import { watch } from './compile';
import { BroilerConfig } from './config';
import { readStream } from './fs';
import { BadRequest, HttpAuth, HttpMethod, HttpRequest, HttpResponse, HttpStatus, Unauthorized } from './http';
import { ApiService, finalizeApiResponse } from './server';
import { forEachKey, transformValues } from './utils/objects';
import { upperFirst } from './utils/strings';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';

import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import * as path from 'path';
import * as url from 'url';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';

import chalk from 'chalk';
const { cyan, green, red, yellow } = chalk;

/**
 * Runs the Webpack development server.
 */
export function serveFrontEnd(options: BroilerConfig, onReady?: () => void): Promise<void> {
    const assetsRootUrl = new URL(options.siteRoot);
    const assetsProtocol = assetsRootUrl.protocol;
    const siteRootUrl = new URL(options.siteRoot);
    const siteProtocol = siteRootUrl.protocol;
    const serverPort = parseInt(siteRootUrl.port, 10);
    const enableHttps = assetsProtocol === 'https:' || siteProtocol === 'https:';
    const defaultPage = options.defaultPage;
    const config = getFrontendWebpackConfig({
        ...options, debug: true, devServer: true, analyze: false,
        authClientId: 'LOCAL_AUTH_CLIENT_ID', // TODO!
        authRoot: `${options.siteRoot}`, // TODO!
    });
    const compiler = webpack(config);
    const devServer = new WebpackDevServer(
        compiler,
        {
            allowedHosts: [
                assetsRootUrl.hostname,
                siteRootUrl.hostname,
            ],
            https: enableHttps,
            stats: {
                colors: true,
            },
            watchOptions: {
                poll: 1000,
            },
            // If default page is provided then serve that page if no
            // other matching page is found.
            historyApiFallback: defaultPage && {index: path.join('/', defaultPage)},
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
export async function serveBackEnd(options: BroilerConfig, params: {[param: string]: string}) {
    const {siteRoot, stageDir, buildDir, projectRootPath} = options;
    const apiRoot = options.apiRoot as string;
    if (!apiRoot) {
        // The app does not have an API -> Nothing to serve
        return;
    }
    const stageDirPath = path.resolve(projectRootPath, stageDir);
    const siteRootUrl = new URL(siteRoot);
    const siteOrigin = siteRootUrl.origin;
    const apiRootUrl = new URL(apiRoot);
    const apiOrigin = apiRootUrl.origin;
    const apiProtocol = apiRootUrl.protocol;
    const serverPort = parseInt(apiRootUrl.port, 10);
    const enableHttps = apiProtocol === 'https:';
    if (enableHttps) {
        throw new Error(`HTTPS is not yet supported on the local REST API server! Switch to use ${apiRoot.replace(/^https/, 'http')} instead!`);
    }
    const cache: {[uri: string]: any} = {};
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
            const apiRequestHandlerFilePath = path.resolve(options.projectRootPath, buildDir, apiRequestHandlerFileName);
            // Ensure that module will be re-loaded
            delete require.cache[apiRequestHandlerFilePath];
            let handler: ApiService = require(apiRequestHandlerFilePath);
            if (!handler || typeof handler.execute !== 'function') {
                // tslint:disable-next-line:no-console
                console.error(red(`The exported API module must have a 'execute' callable!`));
                continue;
            }
            // If user registry is enabled then add APIs for local sign in functionality
            if (options.auth) {
                handler = handler.extend(authLocalServer);
            }
            const environment = {
                ...params,
                ...getRequestEnvironment(handler, stageDirPath),
            };
            // Start the server
            server = http.createServer(async (httpRequest, httpResponse) => {
                try {
                    const response = await handleNodeRequest(httpRequest, handler, {
                        siteOrigin, apiOrigin, siteRoot, apiRoot, environment,
                    }, cache);
                    const textColor = httpRequest.method === 'OPTIONS' ? chalk.dim : (x: string) => x;
                    // tslint:disable-next-line:no-console
                    console.log(textColor(`${httpRequest.method} ${httpRequest.url} → `) + colorizeStatusCode(response.statusCode));
                    httpResponse.writeHead(response.statusCode, response.headers);
                    httpResponse.end(response.body);
                } catch (error) {
                    // tslint:disable-next-line:no-console
                    console.error(`${httpRequest.method} ${httpRequest.url} → ${colorizeStatusCode(500)}\n${red(error.stack || error)}`);
                    httpResponse.writeHead(500, {
                        'Content-Type': 'text/plain',
                    });
                    httpResponse.end(`Internal server error:\n${error.stack || error}`);
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

export function getDbFilePath(directoryPath: string, tableName: string): string {
    return path.resolve(directoryPath, `./db/${tableName}.db`);
}

function getRequestEnvironment(service: ApiService, directoryPath: string): {[key: string]: string} {
    const environment: {[key: string]: string} = {
        DatabaseTableUsersURI: `file://${getDbFilePath(directoryPath, 'Users')}`,
    };
    forEachKey(service.dbTables, (_, table) => {
        const filePath = `file://${getDbFilePath(directoryPath, table.name)}`;
        environment[`DatabaseTable${upperFirst(table.name)}URI`] = filePath;
    });
    return environment;
}

async function handleNodeRequest(nodeRequest: http.IncomingMessage, handler: ApiService, context: {siteOrigin: string, apiOrigin: string, siteRoot: string, apiRoot: string, environment: {[key: string]: string}}, cache: {[uri: string]: any}): Promise<HttpResponse> {
    const {method} = nodeRequest;
    const {siteOrigin} = context;
    const headers = flattenParameters(nodeRequest.headers);
    const authHeader = headers.authorization;
    let auth: HttpAuth | null = null;
    if (authHeader) {
        const authTokenMatch = /^Bearer\s+(\S+)$/.exec(authHeader);
        if (!authTokenMatch) {
            return finalizeApiResponse(new Unauthorized(`Invalid authorization header`), siteOrigin);
        }
        try {
            const payload = jwt.verify(authTokenMatch[1], 'LOCAL_SECRET') as any;
            auth = {
                id: payload.sub,
                name: payload.name,
                email: payload.email,
                picture: payload.picture || null,
                groups: payload['cognito:groups'] || [],
            };
        } catch {
            return finalizeApiResponse(new Unauthorized(`Invalid access token`), siteOrigin);
        }
    }
    const requestUrlObj = url.parse(nodeRequest.url as string, true);
    const request: HttpRequest = {
        method: method as HttpMethod,
        path: requestUrlObj.pathname as string,
        queryParameters: flattenParameters(requestUrlObj.query),
        headers,
        region: 'local',
        auth,
        ...context,
    };
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const chunks = await readStream(nodeRequest);
        const body = chunks.map((chunk) => chunk.toString()).join('');
        request.body = body;
        if (body) {
            try {
                request.payload = JSON.parse(body);
            } catch {
                return finalizeApiResponse(new BadRequest(`Invalid JSON payload`), siteOrigin);
            }
        }
    }
    return await handler.execute(request, cache);
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

function flattenParameters<K extends string>(params: {[P in K]: string | string[] | undefined}): {[P in K]: string} {
    return transformValues(params || {}, (values) => Array.isArray(values) ? values[0] : String(values || ''));
}
