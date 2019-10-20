import { JWK } from 'node-jose';
import { Pool } from 'pg';
import { URL } from 'url';
import { watch } from './compile';
import { BroilerConfig } from './config';
import { escapeForShell, execute, spawn } from './exec';
import { readFile, readStream } from './fs';
import { HttpMethod, HttpRequest, HttpResponse, HttpStatus } from './http';
import { middleware, requestMiddleware } from './middleware';
import { authenticationMiddleware } from './oauth';
import { ApiService, ServerContext } from './server';
import { transformValues } from './utils/objects';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';

import * as http from 'http';
import * as path from 'path';
import * as url from 'url';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';

import chalk from 'chalk';
const { cyan, green, red, yellow } = chalk;

const rawSessionEncryptionKey = {
    kty: 'oct',
    alg: 'A256GCM',
    k: 'oiMylNiaLGsxzrHl3yjGZlaIM4P-agX8ikIlK8pp3Eo',
};

/**
 * Runs the Webpack development server.
 */
export function serveFrontEnd(options: BroilerConfig, onReady?: () => void): Promise<void> {
    const assetsRootUrl = new URL(options.assetsRoot);
    const assetsProtocol = assetsRootUrl.protocol;
    const serverRootUrl = new URL(options.serverRoot);
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
        headers: {
            // Prevent CORS issues with resources
            'Access-Control-Allow-Origin': serverRootUrl.origin,
        },
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
    const {serverRoot, buildDir, projectRootPath} = options;
    const serverRootUrl = new URL(serverRoot);
    const serverOrigin = serverRootUrl.origin;
    const serverProtocol = serverRootUrl && serverRootUrl.protocol;
    const serverPort = serverRootUrl && parseInt(serverRootUrl.port, 10);
    const serverEnableHttps = serverProtocol === 'https:';
    if (serverRoot && serverEnableHttps) {
        throw new Error(`HTTPS is not yet supported on the local server! Switch to use ${serverRoot.replace(/^https/, 'http')} instead!`);
    }
    const htmlPagePath = path.resolve(buildDir, './index.html');
    const dbConnectionPool = new Pool({
        host: 'localhost',
        port: 54320,
        database: 'postgres',
        user: 'postgres',
        idleTimeoutMillis: 60 * 1000,
    });
    const sessionEncryptionKey = await JWK.asKey(rawSessionEncryptionKey);
    const serverContext: ServerContext = {
        dbConnectionPool,
        sessionEncryptionKey,
    };
    const config = getBackendWebpackConfig({...options, debug: true, devServer: true, analyze: false});
    let server: http.Server | undefined;
    try {
        for await (const stats of watch(config)) {
            // Close any previously running server(s)
            if (server) {
                server.close();
                server = undefined;
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
            // NOTE: Webpack type definition is wrong there! Need to force re-cast!
            const assetsByChunkName: Record<string, string[]> = statsJson.assetsByChunkName as any;
            // Get compiled server-site rendering view
            const serverRequestHandlerFileName: string = assetsByChunkName.server && assetsByChunkName.server[0];
            const serverRequestHandlerFilePath = path.resolve(
                projectRootPath, buildDir, serverRequestHandlerFileName,
            );
            // Ensure that module will be re-loaded
            delete require.cache[serverRequestHandlerFilePath];
            // Load the module exporting the service getter
            const serverModule = require(serverRequestHandlerFilePath);
            const service: ApiService = serverModule.default(readFile(htmlPagePath));
            // Get handler for the API requests (if defined)
            const context = {
                serverOrigin, serverRoot,
                environment: {
                    ...params,
                    AuthClientId: 'LOCAL_AUTH_CLIENT_ID',
                    AuthSignInUri: `${serverRoot}/_oauth2_signin`,
                    AuthSignOutUri: `${serverRoot}/_oauth2_signout`,
                    AuthSignInRedirectUri: `${serverRoot}/oauth2/signin`,
                    AuthSignOutRedirectUri: `${serverRoot}/oauth2/signout`,
                },
            };
            const nodeMiddleware = requestMiddleware(async (httpRequest: http.IncomingMessage) => (
                await convertNodeRequest(httpRequest, context)
            ));
            // Set up the server
            const executeServerRequest = middleware(
                authenticationMiddleware(service.execute),
            );
            server = createServer(nodeMiddleware((req) => (
                executeServerRequest(req, serverContext)
            )));
            server.listen(serverPort);
        }
    } finally {
        if (server) {
            server.close();
        }
    }
}

interface LocalDatabaseLaunchOptions {
    name: string;
    stage: string;
    port: number;
}

function getDbDockerContainerName(name: string, stage: string) {
    return `${name}_${stage}_postgres`.replace(/-+/g, '_');
}

export async function launchLocalDatabase({name, stage, port}: LocalDatabaseLaunchOptions): Promise<void> {
    const containerName = escapeForShell(getDbDockerContainerName(name, stage));
    try {
        // Assume that the container already exists. Restart it.
        await execute(`docker restart ${containerName}`);
    } catch {
        // Assuming that the container did not exist. Start a new one.
        await execute(`docker run -d --name ${containerName} -v ${containerName}:/var/lib/postgresql/data -p ${port}:5432 postgres:10`);
    }
}

export async function openLocalDatabasePsql(name: string, stage: string): Promise<void> {
    const containerName = getDbDockerContainerName(name, stage);
    await spawn('docker', ['exec', '-it', '--user=postgres', containerName, 'psql']);
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

async function convertNodeRequest(nodeRequest: http.IncomingMessage, context: {serverOrigin: string, serverRoot: string, environment: {[key: string]: string}}): Promise<HttpRequest> {
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
