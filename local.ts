/* eslint-disable no-continue */
import * as http from 'http';
import transform from 'immuton/transform';
import { JWK } from 'node-jose';
import * as path from 'path';
import type { Pool } from 'pg';
import { URL } from 'url';
import * as url from 'url';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import type { BroilerConfig } from './config';
import { DatabaseTable } from './db';
import { defer, Deferred } from './deferred';
import { escapeForShell, execute, spawn } from './exec';
import { readFile, readStream } from './fs';
import type { HttpMethod, HttpRequest, HttpResponse, HttpStatus } from './http';
import { middleware, requestMiddleware } from './middleware';
import { authenticationMiddleware } from './oauth';
import { cyan, dim, green, red, yellow, underline } from './palette';
import type { Database } from './postgres';
import type { ApiService, ServerContext } from './server';
import { LocalFileStorage } from './storage';
import { users } from './users';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';

const rawSessionEncryptionKey = {
    kty: 'oct',
    alg: 'A256GCM',
    k: 'oiMylNiaLGsxzrHl3yjGZlaIM4P-agX8ikIlK8pp3Eo',
};

export const userTable = new DatabaseTable(users, []);

/**
 * Runs the development server, including the Webpack development server
 * and the backend server.
 */
export async function serve(
    options: BroilerConfig,
    params: { [param: string]: string },
    dbConnectionPool: Pool | null,
): Promise<void> {
    const { stackName, auth, serverRoot, stageDir, buildDir, projectRootPath } = options;
    const assetsRootUrl = new URL(options.assetsRoot);
    const assetsProtocol = assetsRootUrl.protocol;
    const assetsEnableHttps = assetsProtocol === 'https:';
    const assetsServerPort = assetsRootUrl && parseInt(assetsRootUrl.port, 10);
    const serverRootUrl = new URL(serverRoot);
    const serverOrigin = serverRootUrl.origin;
    const serverProtocol = serverRootUrl && serverRootUrl.protocol;
    const serverPort = serverRootUrl && parseInt(serverRootUrl.port, 10);
    const serverEnableHttps = serverProtocol === 'https:';
    const storageDir = path.join(stageDir, 'storage');
    const frontendConfig = getFrontendWebpackConfig({
        ...options,
        debug: options.debug,
        devServer: true,
        analyze: false,
    });
    const devServerOptions = {
        inline: true,
        allowedHosts: [assetsRootUrl.hostname],
        https: assetsEnableHttps,
        stats: {
            colors: true,
        },
        watchOptions: {
            poll: 1000,
        },
        host: assetsRootUrl.hostname,
        port: assetsServerPort,
        // As we are "proxying" the base HTML file, where the script is injected,
        // we need to explicitly define the host of the webpack-dev-server
        public: assetsRootUrl.host,
        headers: {
            // Prevent CORS issues with resources
            'Access-Control-Allow-Origin': serverRootUrl.origin,
        },
        // Write files to disk, as we need to read index.html for SSR
        writeToDisk: true,
    };
    if (serverRoot && serverEnableHttps) {
        throw new Error(
            `HTTPS is not yet supported on the local server! Switch to use ${serverRoot.replace(
                /^https/,
                'http',
            )} instead!`,
        );
    }
    const htmlPagePath = path.resolve(buildDir, './index.html');
    const sessionEncryptionKey = auth ? await JWK.asKey(rawSessionEncryptionKey) : null;
    const backendConfig = getBackendWebpackConfig({
        ...options,
        debug: true,
        devServer: true,
        analyze: false,
    });

    const server = new LocalServer([frontendConfig, backendConfig], devServerOptions, serverPort, async (stats) => {
        // Check for compilation errors
        if (stats.hasErrors()) {
            throw new Error(
                stats.toString({
                    chunks: false, // Makes the build much quieter
                    colors: true, // Shows colors in the console
                }),
            );
        }
        // Successful compilation -> start the HTTP server
        // eslint-disable-next-line no-console
        console.log(stats.toString('minimal'));
        const statsJson = stats.stats[1].toJson();
        // NOTE: Webpack type definition is wrong there! Need to force re-cast!
        const assetsByChunkName = statsJson.assetsByChunkName as Record<string, string[]>;
        // Get compiled server-site rendering view
        const serverAssetFiles = assetsByChunkName.server;
        const serverRequestHandlerFileName: string =
            serverAssetFiles && (serverAssetFiles.find((filename) => /\.js$/.test(filename)) as string);
        const serverRequestHandlerFilePath = path.resolve(projectRootPath, buildDir, serverRequestHandlerFileName);
        // Ensure that module will be re-loaded
        delete require.cache[serverRequestHandlerFilePath];
        let service: ApiService;
        let db: Database | null;
        try {
            // Load the module exporting the service getter
            const serverModule = await import(serverRequestHandlerFilePath);
            const htmlPagePath$ = readFile(htmlPagePath);
            service = serverModule.getApiService(htmlPagePath$, storageDir);
            db = serverModule.getDatabase();
        } catch (error) {
            // eslint-disable-next-line no-console
            throw new Error(red(`Failed to initialize the app: ${error.stack}`));
        }
        // Get handler for the API requests (if defined)
        const nodeMiddleware = requestMiddleware(async (httpRequest: http.IncomingMessage) =>
            convertNodeRequest(httpRequest, serverOrigin, serverRoot),
        );
        // Set up the server
        const executeServerRequest = middleware(authenticationMiddleware(service.execute));
        const storage = new LocalFileStorage(serverOrigin, storageDir);
        const serverContext: ServerContext = {
            stackName,
            db,
            dbConnectionPool,
            sessionEncryptionKey,
            storage,
            userPoolId: null,
            region: 'local',
            authClientId: auth ? 'LOCAL_AUTH_CLIENT_ID' : null,
            authClientSecret: auth ? 'LOCAL_AUTH_CLIENT_SECRET' : null,
            authSignInUri: auth ? `${serverRoot}/_oauth2_signin` : null,
            authSignOutUri: auth ? `${serverRoot}/_oauth2_signout` : null,
            authTokenUri: null,
            environment: params,
        };
        return nodeMiddleware((req) => executeServerRequest(req, serverContext));
    });
    try {
        await server.start();
    } finally {
        server.close();
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

export async function launchLocalDatabase({ name, stage, port }: LocalDatabaseLaunchOptions): Promise<void> {
    const containerName = escapeForShell(getDbDockerContainerName(name, stage));
    try {
        // Assume that the container already exists. Restart it.
        await execute(`docker restart ${containerName}`);
    } catch {
        // Assuming that the container did not exist. Start a new one.
        await execute(
            `docker run -d --name ${containerName} -v ${containerName}:/var/lib/postgresql/data -p ${port}:5432 postgres:10`,
        );
    }
}

export async function openLocalDatabasePsql(name: string, stage: string): Promise<void> {
    const containerName = getDbDockerContainerName(name, stage);
    await spawn('docker', ['exec', '-it', '--user=postgres', containerName, 'psql']);
}

type ServerHandler = (request: http.IncomingMessage) => Promise<HttpResponse>;

class LocalServer {
    private compiler: webpack.MultiCompiler;

    private handlerDeferred: Deferred<ServerHandler> = defer();

    private devServer: WebpackDevServer;

    public readonly server: http.Server;

    constructor(
        private readonly configurations: webpack.Configuration[],
        private readonly webpackDevServerConfiguration: WebpackDevServer.Configuration & { port: number },
        private readonly serverPort: number,
        private readonly buildHandler: (stats: webpack.compilation.MultiStats) => Promise<ServerHandler>,
    ) {
        const compiler = webpack(this.configurations);
        compiler.hooks.watchRun.tap('Broiler', () => {
            // Pause handling HTTP requests, leaving them pending
            this.resetHandler();
        });
        compiler.hooks.done.tap('Broiler', async (stats) => {
            try {
                const handler = await this.buildHandler(stats);
                this.setHandler(handler);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(error.message);
            }
        });
        this.compiler = compiler;
        this.devServer = new WebpackDevServer(this.compiler, this.webpackDevServerConfiguration);
        this.server = http.createServer(async (httpRequest, httpResponse) => {
            try {
                const handler = await this.handlerDeferred.promise;
                const response = await handler(httpRequest);
                const contentTypes = response.headers['Content-Type'];
                const contentType = Array.isArray(contentTypes) ? contentTypes[0] : contentTypes;
                const isHtml = contentType && /^text\/html(;|$)/.test(contentType);
                // eslint-disable-next-line no-nested-ternary
                const textColor = isHtml ? cyan : httpRequest.method === 'OPTIONS' ? dim : (x: string) => x; // no color
                // eslint-disable-next-line no-console
                console.log(
                    textColor(`${httpRequest.method} ${httpRequest.url} → `) + colorizeStatusCode(response.statusCode),
                );
                httpResponse.writeHead(response.statusCode, response.headers);
                httpResponse.end(response.body);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(
                    `${httpRequest.method} ${httpRequest.url} → ${colorizeStatusCode(500)}\n${red(
                        error.stack || error,
                    )}`,
                );
                httpResponse.writeHead(500, {
                    'Content-Type': 'text/plain',
                });
                httpResponse.end(`Internal server error:\n${error.stack || error}`);
            }
        });
    }

    public async start(): Promise<void> {
        const webpackDevServerPort = this.webpackDevServerConfiguration.port;
        const webpackDevServerLaunch = new Promise<never>((_, reject) => {
            const server = this.devServer.listen(webpackDevServerPort, (err) => {
                if (err) {
                    reject(err);
                } else {
                    // eslint-disable-next-line no-console
                    console.log(
                        `Serving the local development website at ${underline(
                            `${this.webpackDevServerConfiguration.public}/`,
                        )}`,
                    );
                }
            });
            server.on('error', (err) => reject(err));
        });
        const httpServerPort = this.serverPort;
        const httpServerLaunch = new Promise<never>((_, reject) => {
            this.server.listen(httpServerPort, () => {
                // eslint-disable-next-line no-console
                console.log(`Serving the local development server at port ${httpServerPort}`);
            });
            this.server.on('error', (err) => {
                // eslint-disable-next-line no-console
                console.error(red(`Failed to set up the server: ${err.stack}`));
                reject(err);
            });
        });
        await Promise.all([webpackDevServerLaunch, httpServerLaunch]);
    }

    public setHandler(handler: ServerHandler) {
        this.handlerDeferred.resolve(handler);
    }

    public resetHandler() {
        const deferred: Deferred<ServerHandler> = defer();
        this.handlerDeferred.resolve(deferred.promise);
        this.handlerDeferred = deferred;
    }

    public async close() {
        await Promise.all([(async () => this.server.close())(), (async () => this.devServer.close())()]);
    }
}

async function convertNodeRequest(
    nodeRequest: http.IncomingMessage,
    serverOrigin: string,
    serverRoot: string,
): Promise<HttpRequest> {
    const { method } = nodeRequest;
    const headers = flattenParameters(nodeRequest.headers);
    const requestUrlObj = url.parse(nodeRequest.url as string, true);
    const req: HttpRequest = {
        method: method as HttpMethod,
        path: requestUrlObj.pathname as string,
        queryParameters: flattenParameters(requestUrlObj.query),
        headers,
        region: 'local',
        auth: null, // NOTE: This will be set by another middleware!
        serverOrigin,
        serverRoot,
    };
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const chunks = await readStream(nodeRequest);
        const body = Buffer.concat(chunks);
        req.body = body;
    }
    return req;
}

function colorizeStatusCode(statusCode: HttpStatus): string {
    const codeStr = String(statusCode);
    if (statusCode >= 200 && statusCode < 300) {
        return green(codeStr);
    }
    if (statusCode >= 300 && statusCode < 400) {
        return cyan(codeStr);
    }
    if (statusCode >= 400 && statusCode < 500) {
        return yellow(codeStr);
    }
    if (statusCode >= 500 && statusCode < 600) {
        return red(codeStr);
    }
    return codeStr;
}

function flattenParameters<K extends string>(
    params: { [P in K]: string | string[] | undefined },
): { [P in K]: string } {
    return transform(params || {}, (values) => (Array.isArray(values) ? values[0] : String(values || '')));
}
