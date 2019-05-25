import { URL } from 'url';
import authLocalServer from './auth-local-server';
import { watch } from './compile';
import { BroilerConfig } from './config';
import { readStream } from './fs';
import { HttpAuth, HttpMethod, HttpRequest, HttpResponse, HttpStatus, Unauthorized } from './http';
import { middleware, requestMiddleware } from './middleware';
import { ApiService } from './server';
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
import { request } from './request';
const { cyan, green, red, yellow } = chalk;

/**
 * Runs the Webpack development server.
 */
export function serveFrontEnd(options: BroilerConfig, onReady?: () => void): Promise<void> {
    const assetsRootUrl = new URL(options.assetsRoot);
    const assetsProtocol = assetsRootUrl.protocol;
    const serverPort = parseInt(assetsRootUrl.port, 10);
    const enableHttps = assetsProtocol === 'https:';
    const config = getFrontendWebpackConfig({
        ...options, debug: options.debug, devServer: true, analyze: false,
    });
    const devServerOptions: WebpackDevServer.Configuration = {
        inline: true,
        allowedHosts: [
            assetsRootUrl.hostname,
        ],
        https: enableHttps,
        stats: {
            colors: true,
        },
        watchOptions: {
            poll: 1000,
        },
        host: assetsRootUrl.hostname,
        port: serverPort,
        // As we are "proxying" the base HTML file, where the script is injected,
        // we need to explicitly define the host of the webpack-dev-server
        public: assetsRootUrl.host,
    };
    WebpackDevServer.addDevServerEntrypoints(config, devServerOptions);
    const compiler = webpack(config);
    const devServer = new WebpackDevServer(compiler, devServerOptions);
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
    const {siteRoot, apiRoot, assetsRoot, stageDir, buildDir, projectRootPath} = options;
    const stageDirPath = path.resolve(projectRootPath, stageDir);
    const siteRootUrl = new URL(siteRoot);
    const siteOrigin = siteRootUrl.origin;
    const siteProtocol = siteRootUrl && siteRootUrl.protocol;
    const siteServerPort = siteRootUrl && parseInt(siteRootUrl.port, 10);
    const siteEnableHttps = siteProtocol === 'https:';
    if (siteRoot && siteEnableHttps) {
        throw new Error(`HTTPS is not yet supported on the local server! Switch to use ${siteRoot.replace(/^https/, 'http')} instead!`);
    }
    const apiRootUrl = apiRoot && new URL(apiRoot);
    const apiOrigin = apiRootUrl && apiRootUrl.origin;
    const apiProtocol = apiRootUrl && apiRootUrl.protocol;
    const apiServerPort = apiRootUrl && parseInt(apiRootUrl.port, 10);
    const apiEnableHttps = apiProtocol === 'https:';
    if (apiRoot && apiEnableHttps) {
        throw new Error(`HTTPS is not yet supported on the local REST API server! Switch to use ${apiRoot.replace(/^https/, 'http')} instead!`);
    }
    const htmlPageUrl = `${assetsRoot}/index.html`;
    const cache: {[uri: string]: any} = {};
    const config = getBackendWebpackConfig({...options, debug: true, devServer: true, analyze: false});
    let ssrServer: http.Server | undefined;
    let apiServer: http.Server | undefined;
    try {
        for await (const stats of watch(config)) {
            // Close any previously running server(s)
            if (ssrServer) {
                ssrServer.close();
                ssrServer = undefined;
            }
            if (apiServer) {
                apiServer.close();
                apiServer = undefined;
            }
            // Check for compilation errors
            if (stats.hasErrors()) {
                // tslint:disable-next-line:no-console
                console.error(stats.toString({
                    chunks: false, // Makes the build much quieter
                    colors: true, // Shows colors in the console
                }));
                continue;
            }
            // Successful compilation -> start the HTTP server
            // tslint:disable-next-line:no-console
            console.log(stats.toString('minimal'));

            const statsJson = stats.toJson();
            const {assetsByChunkName} = statsJson;
            // Get compiled server-site rendering view
            const ssrRequestHandlerFileName: string = assetsByChunkName.ssr && assetsByChunkName.ssr[0];
            const ssrRequestHandlerFilePath = path.resolve(
                projectRootPath, buildDir, ssrRequestHandlerFileName,
            );
            // Ensure that module will be re-loaded
            delete require.cache[ssrRequestHandlerFilePath];
            // Load the module exporting the rendered React component
            const siteModule = require(ssrRequestHandlerFilePath);
            const siteRequestExecutor: (req: HttpRequest, htmlPage: string) => Promise<HttpResponse> = siteModule.default;
            // Get handler for the API requests (if defined)
            const apiRequestHandlerFileName: string | undefined = assetsByChunkName.api && assetsByChunkName.api[0];
            const apiRequestHandlerFilePath = apiRequestHandlerFileName && path.resolve(
                projectRootPath, buildDir, apiRequestHandlerFileName,
            );
            let apiHandler: ApiService | undefined;
            if (apiRequestHandlerFilePath) {
                // Ensure that module will be re-loaded
                delete require.cache[apiRequestHandlerFilePath];
                const serviceModule = require(apiRequestHandlerFilePath);
                apiHandler = serviceModule.default;
                if (!apiHandler || typeof apiHandler.execute !== 'function') {
                    // tslint:disable-next-line:no-console
                    console.error(red(`The module ${options.serverFile} must export an APIService instance as a default export!`));
                    continue;
                }
                // If user registry is enabled then add APIs for local sign in functionality
                if (options.auth) {
                    apiHandler = apiHandler.extend(authLocalServer);
                }
            }
            const context = {
                apiOrigin: apiOrigin || '',
                apiRoot: apiRoot || '',
                siteOrigin, siteRoot,
                environment: {
                    ...params,
                    AuthClientId: 'LOCAL_AUTH_CLIENT_ID',
                    AuthSignInUri: `${siteRoot}/_oauth2_signin`,
                    AuthSignOutUri: `${siteRoot}/_oauth2_signout`,
                    AuthSignInRedirectUri: `${assetsRoot}/_oauth2_signin_complete.html`,
                    AuthSignOutRedirectUri: `${assetsRoot}/_oauth2_signout_complete.html`,
                    ...getRequestEnvironment(stageDirPath, apiHandler),
                },
            };
            const nodeMiddleware = requestMiddleware(async (httpRequest: http.IncomingMessage) => (
                await convertNodeRequest(httpRequest, context)
            ));
            // Set up the server for the view rendering
            const executeSrrRequest = nodeMiddleware(middleware(
                async (req) => {
                    const htmlPageResponse = await request({
                        url: htmlPageUrl,
                        method: 'GET',
                    });
                    const htmlPage = htmlPageResponse.body;
                    return await siteRequestExecutor(req, htmlPage);
                },
            ));
            ssrServer = createServer(executeSrrRequest);
            ssrServer.listen(siteServerPort);
            // Set up the server for the API
            if (apiHandler) {
                const executeApiRequest = nodeMiddleware(middleware(
                    localAuthenticationMiddleware(apiHandler.execute),
                ));
                // Start the server
                apiServer = createServer(executeApiRequest, cache);
                apiServer.listen(apiServerPort);
            }
        }
    } finally {
        try {
            if (ssrServer) { ssrServer.close(); }
        } finally {
            if (apiServer) { apiServer.close(); }
        }
    }
}

export function getDbFilePath(directoryPath: string, tableName: string): string {
    return path.resolve(directoryPath, `./db/${tableName}.db`);
}

function createServer<P extends any[]>(handler: (request: http.IncomingMessage, ...args: P) => Promise<HttpResponse>, ...args: P) {
    return http.createServer(async (httpRequest, httpResponse) => {
        try {
            const response = await handler(httpRequest, ...args);
            const contentType = response.headers['Content-Type'];
            const isHtml = contentType && /^text\/html(;|$)/.test(contentType);
            const textColor = isHtml ? chalk.cyan :
                httpRequest.method === 'OPTIONS' ? chalk.dim :
                (x: string) => x // no color
            ;
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
}

function getRequestEnvironment(directoryPath: string, service?: ApiService): {[key: string]: string} {
    const environment: {[key: string]: string} = {
        DatabaseTableUsersURI: `file://${getDbFilePath(directoryPath, 'Users')}`,
    };
    if (service) {
        forEachKey(service.dbTables, (_, table) => {
            const filePath = `file://${getDbFilePath(directoryPath, table.name)}`;
            environment[`DatabaseTable${upperFirst(table.name)}URI`] = filePath;
        });
    }
    return environment;
}

async function convertNodeRequest(nodeRequest: http.IncomingMessage, context: {siteOrigin: string, apiOrigin: string, siteRoot: string, apiRoot: string, environment: {[key: string]: string}}): Promise<HttpRequest> {
    const {method} = nodeRequest;
    const headers = flattenParameters(nodeRequest.headers);
    const requestUrlObj = url.parse(nodeRequest.url as string, true);
    const req: HttpRequest = {
        method: method as HttpMethod,
        path: requestUrlObj.pathname as string,
        queryParameters: flattenParameters(requestUrlObj.query),
        headers,
        region: 'local',
        auth: null, // NOTE: This will be set by another middleware!
        ...context,
    };
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const chunks = await readStream(nodeRequest);
        const body = chunks.map((chunk) => chunk.toString()).join('');
        req.body = body;
    }
    return req;
}

const localAuthenticationMiddleware = requestMiddleware(async (req: HttpRequest) => {
    const authHeader = req.headers.Authorization;
    let auth: HttpAuth | null = null;
    if (authHeader) {
        const authTokenMatch = /^Bearer\s+(\S+)$/.exec(authHeader);
        if (!authTokenMatch) {
            throw new Unauthorized(`Invalid authorization header`);
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
            throw new Unauthorized(`Invalid access token`);
        }
    }
    return {...req, auth};
});

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
