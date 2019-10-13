// tslint:disable:member-ordering
import { SecretsManager } from 'aws-sdk';
import { Pool, PoolConfig } from 'pg';
import { Handler, ResponseHandler } from './api';
import { Cache, cached } from './cache';
import { Model, Table } from './db';
import { ApiResponse, HttpResponse, OK } from './http';
import { HttpMethod, HttpRequest, HttpStatus, isResponse, MethodNotAllowed, NoContent, NotFound, NotImplemented, Unauthorized } from './http';
import { AuthenticationType, Operation } from './operations';
import { Page } from './pagination';
import { parsePayload } from './parser';
import { PostgreSqlPoolConnection, SqlConnection } from './postgres';
import { Url, UrlPattern } from './url';
import { sort } from './utils/arrays';
import { transformValues } from './utils/objects';

export type Tables<T> = {
    [P in keyof T]: Table<T[P]>;
};

type Implementables<I, O, R> = (
    {[P in keyof I]: Operation<I[P], any, any>} &
    {[P in keyof O]: Operation<any, O[P], any>} &
    {[P in keyof R]: Operation<any, any, R[P]>}
);
type OperationImplementors<I, O, D, R> = {
    [P in keyof I & keyof O & keyof R]: Handler<I[P], O[P], D, R[P]>;
};

export interface Controller {
    /**
     * All HTTP methods accepted by this endpoint.
     */
    methods: HttpMethod[];
    /**
     * URL path pattern that matches this endpoint.
     */
    pattern: UrlPattern;
    /**
     * Whether or not this controller requires authenticated user.
     */
    requiresAuth: boolean;
    /**
     * Array of database tables required by this controller.
     */
    tables: Array<Table<any>>;
    /**
     * Respond to the given request with either an API response
     * or a raw HTTP response. The handler should THROW (not return)
     * - 501 HTTP error to indicate that the URL is not for this controller
     * - 405 HTTP error if the request method was one of the `methods`
     */
    execute(request: HttpRequest, cache?: Cache): Promise<ApiResponse | HttpResponse>;
}

class ImplementedOperation implements Controller {

    public readonly methods: HttpMethod[];
    public readonly pattern: UrlPattern;
    public readonly tables: Array<Table<any>>;
    public readonly requiresAuth: boolean;

    constructor(
        public readonly operation: Operation<any, any, AuthenticationType>,
        public readonly tablesByName: Tables<any>,
        private readonly handler: ResponseHandler<any, any, any, any>,
    ) {
        const {methods, route, authType} = operation;
        this.methods = methods;
        this.pattern = route.pattern;
        this.tables = Object.values(tablesByName);
        this.requiresAuth = authType !== 'none';
    }

    public async execute(request: HttpRequest, cache: Cache): Promise<ApiResponse> {
        const {tablesByName, operation} = this;
        const {authType, userIdAttribute, responseSerializer} = operation;
        const input = parseRequest(operation, request);
        // Check the authentication
        const {auth} = request;
        const isAdmin = !!auth && auth.groups.indexOf('Administrators') < 0;
        if (authType !== 'none') {
            if (!auth) {
                throw new Unauthorized(`Unauthorized`);
            }
            if (authType === 'admin' && isAdmin) {
                // Not an admin!
                throw new Unauthorized(`Administrator rights are missing.`);
            }
            if (authType !== 'user') {
                // Needs to be either owner or admin!
                // TODO: Handle invalid configuration where auth == 'owner' && !userIdAttribute!
                if (userIdAttribute && input[userIdAttribute] !== auth.id && !isAdmin) {
                    throw new Unauthorized(`Unauthorized resource`);
                }
            }
        }
        // Handle the request
        const { region, environment } = request;
        const sqlConnection = await establishDatabaseConnection(region, environment, cache);
        try {
            const models = transformValues(tablesByName, (table) => (
                table.getModel(region, environment, sqlConnection)
            ));
            const {data, ...response} = await this.handler(input, models, request);
            if (!responseSerializer) {
                // No response data should be available
                return response;
            }
            // Serialize the response data
            // TODO: Validation errors should result in 500 responses!
            return {...response, data: responseSerializer.serialize(data)};
        } finally {
            // Ensure that any database connection is released to the pool
            await sqlConnection.disconnect();
        }
    }
}

export function implement<I, O, R, D>(
    operation: Operation<I, O, R>,
    db: Tables<D>,
    implementation: Handler<I, O, D, R>,
): Controller {
    switch (operation.type) {
        case 'list':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: D, request: HttpRequest): Promise<OK<Page<O, any>>> => {
                // TODO: Avoid force-typecasting of request!
                const page: Page<any, any> = await implementation(input, models, request as unknown as R) as any;
                if (!page.next) {
                    return new OK(page);
                }
                const url = operation.route.compile(page.next);
                const next = `${request.serverOrigin}${url}`;
                const headers = {Link: `${next}; rel="next"`};
                return new OK(page, headers);
            },
        );
        case 'retrieve':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: D, request: R): Promise<OK<O>> => {
                return new OK(await implementation(input, models, request));
            },
        );
        case 'destroy':
        return new ImplementedOperation(
            operation, db,
            async (input: I, models: D, request: R): Promise<NoContent> => {
                await implementation(input, models, request);
                return new NoContent();
            },
        );
        default:
        // With other methods, use implementation as-is
        return new ImplementedOperation(operation, db, implementation as any);
    }
}

export function implementAll<I, O, R, D>(
    operations: Implementables<I, O, R>, db: Tables<D>,
) {
    function using(
        implementors: OperationImplementors<I, O, D, R>,
    ): Record<keyof I & keyof O & keyof R, Controller> {
        return transformValues(operations as {[key: string]: Operation<any, any, any>}, (operation, key) => (
            implement(operation, db, implementors[key as keyof I & keyof O & keyof R])
        )) as Record<keyof I & keyof O & keyof R, Controller>;
    }
    return {using};
}

export class ApiService {

    public readonly tables: Array<Table<Model<any, any, any, any, any>>>;
    public readonly controllers: Controller[];

    constructor(
        public readonly controllersByName: Record<string, Controller>,
    ) {
        const tablesByName: Record<string, Table<Model<any, any, any, any, any>>> = {};
        // IMPORTANT: Sort controllers by pattern, because this way static path components
        // take higher priority than placeholders, e.g. `/api/foobar` comes before `/{path+}`
        this.controllers = sort(Object.values(controllersByName), ({pattern}) => pattern.pattern, 'asc');
        this.controllers.forEach((controller) => {
            Object.values(controller.tables).forEach((table) => {
                tablesByName[table.name] = table;
            });
        });
        this.tables = Object.values(tablesByName);
    }

    public execute = async (request: HttpRequest, cache?: Cache) => {
        let errorResponse: ApiResponse | HttpResponse = new NotFound(`API endpoint not found.`);
        // TODO: Configure TypeScript to allow using iterables on server side
        const controllers = Array.from(this.iterateForPath(request.path));
        // Respond to an OPTIONS request
        if (request.method === 'OPTIONS') {
            // Get the combined methods of all matching operations
            const methods: HttpMethod[] = [];
            for (const controller of controllers) {
                methods.push(...controller.methods);
            }
            // If no methods found, then this is a unknown URL
            // This should not be possible with API gateway, but possible with the local server
            if (!methods.length) {
                return errorResponse;
            }
            // Respond with the CORS headers
            return {
                statusCode: 200,
                headers: {'Access-Control-Allow-Methods': methods.join(', ')},
                body: '',
            } as HttpResponse;
        }
        // Otherwise find the first implementation that processes the response
        for (const implementation of controllers) {
            try {
                // Return response directly returned by the implementation
                return await implementation.execute(request, cache);
            } catch (error) {
                // Thrown 405 or 501 response errors will have a special meaning
                if (isResponse(error)) {
                    if (error.statusCode === HttpStatus.NotImplemented) {
                        // Continue to the next implementation
                        continue;
                    } else if (error.statusCode === HttpStatus.MethodNotAllowed) {
                        // The URL matches, but the method is not valid.
                        // Some other implementation might still accept this method,
                        // so continue iterating, or finally return this 405 if not found.
                        errorResponse = error;
                        continue;
                    }
                }
                // Raise through
                throw error;
            }
        }
        // This should not be possible with API gateway, but possible with the local server
        return errorResponse;
    }

    public extend(controllers: Record<string, Controller>) {
        return new ApiService({...this.controllersByName, ...controllers});
    }

    public getTable(tableName: string): Table<Model<any, any, any, any, any>> | undefined {
        return this.tables.find((table) => table.name === tableName);
    }

    private *iterateForPath(path: string) {
        const url = new Url(path);
        for (const controller of this.controllers) {
            // NOTE: We just make a simple match against the path!
            if (controller.pattern.match(url)) {
                yield controller;
            }
        }
    }
}

async function establishDatabaseConnection(region: string, environment: {[key: string]: string}, cache: Cache): Promise<SqlConnection> {
    // Create a database pool
    const databaseHost = environment.DatabaseHost;
    const databasePort = environment.DatabasePort;
    const databaseName = environment.DatabaseName;
    if (!databaseHost) {
        throw new Error(`Missing database host configuration!`);
    }
    if (!databasePort) {
        throw new Error(`Missing database port configuration!`);
    }
    if (!databaseName) {
        throw new Error(`Missing database name configuration!`);
    }
    const poolCacheKey = `pg:pool:${databaseHost}:${databasePort}:${databaseName}`;
    const pool = await cached(cache, poolCacheKey, async () => {
        const dbConfig: PoolConfig = {
            host: databaseHost,
            port: parseInt(databasePort, 10),
            database: databaseName,
            idleTimeoutMillis: 60 * 1000,
        };
        const databaseCredentialsArn = environment.DatabaseCredentialsArn;
        if (databaseCredentialsArn) {
            // Username and password are read from AWS Secrets Manager
            const credentialsCacheKey = `pg:credentials:${databaseCredentialsArn}`;
            const credentials = await cached(cache, credentialsCacheKey, async () => {
                return retrieveDatabaseCredentials(region, databaseCredentialsArn);
            });
            dbConfig.user = credentials.username;
            dbConfig.password = credentials.password;
        } else {
            // Assuming a local development environment. No password!
            dbConfig.user = 'postgres';
        }
        return new Pool(dbConfig);
    });
    return new PostgreSqlPoolConnection(pool);
}

async function retrieveDatabaseCredentials(region: string, secretArn: string) {
    const sdk = new SecretsManager({
        apiVersion: '2017-10-17',
        region,
        httpOptions: { timeout: 5 * 1000 },
        maxRetries: 3,
    });
    const response = await sdk.getSecretValue({ SecretId: secretArn }).promise();
    const secret = response.SecretString;
    if (!secret) {
        throw new Error('Response does not contain a SecretString');
    }
    const { username, password } = JSON.parse(secret);
    if (typeof username !== 'string' || !username) {
        throw new Error('Secrets manager credentials are missing "username"');
    }
    if (typeof password !== 'string' || !password) {
        throw new Error('Secrets manager credentials are missing "password"');
    }
    return { username, password };
}

function parseRequest<I>(operation: Operation<I, any, any>, request: HttpRequest): I {
    const {path, queryParameters, method, body = '', headers} = request;
    const url = new Url(path, queryParameters);
    if (!operation.route.pattern.match(url)) {
        // The pattern doesn't match this URL path
        // Not matching endpoint
        // This error code indicates to the caller that it should probably find another endpoint
        throw new NotImplemented(`Request not processable by this endpoint`);
    }
    if (operation.methods.indexOf(method) < 0) {
        // URL matches but the method is not accepted
        throw new MethodNotAllowed(`Method ${method} is not allowed`);
    }
    // NOTE: Raises validation error if matches but invalid
    const urlParameters = operation.route.match(url);
    const payloadSerializer = operation.getPayloadSerializer(method);
    if (!payloadSerializer) {
        // No payload, just URL parameters
        return urlParameters;
    }
    // Deserialize/decode the payload, raising validation error if invalid
    const { 'Content-Type': contentTypeHeader = 'application/json'} = headers;
    const payload = parsePayload(payloadSerializer, body, contentTypeHeader);
    // TODO: Gather validation errors togeter?
    return {...urlParameters, ...payload};
}
