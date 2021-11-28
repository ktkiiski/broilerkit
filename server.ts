/* eslint-disable @typescript-eslint/no-explicit-any */
import isNotNully from 'immuton/isNotNully';
import sort from 'immuton/sort';
import transform from 'immuton/transform';
import type { ExcludedKeys, FilteredKeys } from 'immuton/types';
import type { JWK } from 'node-jose';
import type { Pool } from 'pg';
import { list, retrieve } from './db';
import { ResourceEffect, getSerializedStateEffectChanges } from './effects';
import { executeHandler, Handler, HandlerContext, HandlerServerContext } from './handlers';
import {
    HttpMethod,
    HttpRequest,
    HttpStatus,
    isResponse,
    MethodNotAllowed,
    NotFound,
    NotImplemented,
    SuccesfulResponse,
    ApiResponse,
    HttpResponse,
    OK,
} from './http';
import type { AuthenticationType, Operation, OperationType } from './operations';
import type { Page } from './pagination';
import { parsePayload } from './parser';
import { authorize } from './permissions';
import type { Database } from './postgres';
import type { UserSession } from './sessions';
import type { FileStorage } from './storage';
import { Url, UrlPattern } from './url';

export type ResponseHandler<I, O, R = HttpRequest> = Handler<I, SuccesfulResponse<O>, R>;

type Implementables<I, O, R, T extends Record<string, OperationType>> = {
    [P in keyof I]: Operation<I[P], any, any, any>;
} &
    { [P in keyof O]: Operation<any, O[P], any, any> } &
    { [P in keyof R]: Operation<any, any, R[P], any> } &
    { [P in keyof T]: Operation<any, any, any, T[P]> };
type OperationImplementors<I, O, R, T> = {
    [P in keyof I & keyof O & keyof R & ExcludedKeys<T, 'retrieve' | 'list'>]: Handler<I[P], O[P], R[P]>;
} &
    {
        [P in keyof I & keyof O & keyof R & FilteredKeys<T, 'retrieve' | 'list'>]?: Handler<I[P], O[P], R[P]>;
    };

/**
 * Essentials the server that remain the same
 * between requests.
 */
export interface ServerContext {
    /**
     * Name of the app deployment stack.
     */
    stackName: string;
    /**
     * Information about the database.
     */
    db: Database | null;
    /**
     * Client for accessing and managing file storage.
     */
    storage: FileStorage;
    /**
     * ID of the authentication client, if enabled.
     */
    authClientId: string | null;
    /**
     * Authentication client secret, if enabled.
     */
    authClientSecret: string | null;
    /**
     * OAuth2 sign in URI, if enabled.
     */
    authSignInUri: string | null;
    /**
     * OAuth2 sign out URI, if enabled.
     */
    authSignOutUri: string | null;
    /**
     * OAuth2 token endpoint URI, if enabled.
     */
    authTokenUri: string | null;
    /**
     * ID of the user pool, if enabled.
     */
    userPoolId: string | null;
    /**
     * Region of the server, or "local" if running locally.
     */
    region: string;
    /**
     * A pool for PostgreSQL database connections
     * available for the requests.
     */
    dbConnectionPool: Pool | null;
    /**
     * Encryption key for user sessions.
     */
    sessionEncryptionKey: JWK.Key | null;
    /**
     * Stage-specific environment configuration
     */
    environment: { [variable: string]: string };
}

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
     * Respond to the given request with either an API response
     * or a raw HTTP response. The handler should THROW (not return)
     * - 501 HTTP error to indicate that the URL is not for this controller
     * - 405 HTTP error if the request method was one of the `methods`
     */
    execute(request: HttpRequest, context: HandlerServerContext): Promise<ApiResponse | HttpResponse>;
    /**
     * Related API operation, if any.
     */
    operation?: Operation<any, any, any>;
}

class ImplementedOperation implements Controller {
    public readonly methods: HttpMethod[];

    public readonly pattern: UrlPattern;

    constructor(
        public readonly operation: Operation<any, any, AuthenticationType>,
        private readonly handler: ResponseHandler<any, any>,
    ) {
        const { methods, route } = operation;
        this.methods = methods;
        this.pattern = route.pattern;
    }

    public async execute(request: HttpRequest, context: HandlerServerContext): Promise<ApiResponse> {
        const { operation } = this;
        const { responseSerializer } = operation;
        const input = parseRequest(operation, request);
        // Authorize the access
        const { auth } = request;
        authorize(operation, auth, input);
        // Handle the request
        const { data, ...response } = await executeHandler(this.handler, input, context, request);
        // Wrap to the envelope
        const responseData = !responseSerializer
            ? {}
            : {
                  // Reponse data
                  data: responseSerializer.serialize(data),
                  // TODO: Add side effects here
              };
        // Serialize the response data
        // TODO: Validation errors should result in 500 responses!
        return {
            ...response,
            data: responseData,
        };
    }
}

function implement<I, O, R>(operation: Operation<I, O, R>, implementation: Handler<I, O, R>): Controller {
    switch (operation.type) {
        case 'list':
            return new ImplementedOperation(
                operation,
                async (input: I, request): Promise<OK<Page<O, any>>> => {
                    // TODO: Avoid force-typecasting of request!
                    const page: Page<any, any> = (await implementation(
                        input,
                        (request as unknown) as R & HandlerContext,
                    )) as any;
                    if (!page.next) {
                        return new OK(page);
                    }
                    const url = operation.route.compile(page.next);
                    const next = `${request.serverOrigin}${url}`;
                    const headers = { Link: `${next}; rel="next"` };
                    return new OK(page, headers);
                },
            );
        case 'retrieve':
            return new ImplementedOperation(
                operation,
                async (input: I, request): Promise<OK<O>> => {
                    // TODO: Avoid force-typecasting of request!
                    return new OK(await implementation(input, (request as unknown) as R & HandlerContext));
                },
            );
        case 'destroy':
            return new ImplementedOperation(
                operation,
                async (input: I, request): Promise<OK<null>> => {
                    // TODO: Avoid force-typecasting of request!
                    await implementation(input, (request as unknown) as R & HandlerContext);
                    return new OK(null);
                },
            );
        default:
            // With other methods, use implementation as-is
            return new ImplementedOperation(operation, implementation as any);
    }
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function implementAll<I, O, R, T extends Record<string, OperationType>>(operations: Implementables<I, O, R, T>) {
    function using(
        implementors: OperationImplementors<I, O, R, T>,
    ): Record<keyof I & keyof O & keyof R & keyof T, Controller> {
        return transform(operations as { [key: string]: Operation<any, any, any> }, (operation, key) => {
            const implementor = (implementors as any)[key as keyof I & keyof O & keyof R & keyof T];
            if (implementor) {
                return implement(operation, implementor);
            }
            // Default implementation for retrieve API
            const { type } = operation;
            const { resource, pattern } = operation.endpoint;
            if (type === 'retrieve') {
                return implement(operation, async (query, { db }) => db.run(retrieve(resource, query)));
            }
            if (type === 'list') {
                return implement(operation, async (query, { db }) => db.run(list(resource, query)));
            }
            throw new Error(`Missing implementation for ${type} at ${pattern.pattern}`);
        }) as Record<keyof I & keyof O & keyof R & keyof T, Controller>;
    }
    return { using };
}

export class ApiService {
    public readonly controllers: Controller[];

    public readonly operations: Operation<any, any, any>[];

    constructor(private readonly controllersByName: Record<string, Controller>) {
        // IMPORTANT: Sort controllers by pattern, because this way static path components
        // take higher priority than placeholders, e.g. `/api/foobar` comes before `/{path+}`
        this.controllers = sort(Object.values(controllersByName), ({ pattern }) => pattern.pattern, 'asc');
        this.operations = this.controllers.map(({ operation }) => operation).filter(isNotNully);
    }

    public execute = async (request: HttpRequest, context: ServerContext): Promise<ApiResponse<any> | HttpResponse> => {
        const { operations } = this;
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
                headers: { 'Access-Control-Allow-Methods': methods.join(', ') },
                body: '',
            } as HttpResponse;
        }
        const effects: ResourceEffect[] = [];
        const requestContext = { ...context, effects };
        // Otherwise find the first implementation that processes the response
        for (const implementation of controllers) {
            try {
                // Return response directly returned by the implementation
                const response = await implementation.execute(request, requestContext);
                return applyResponseEffects(response, request.auth, effects, operations);
            } catch (error) {
                // Thrown 405 or 501 response errors will have a special meaning
                if (isResponse(error)) {
                    if (error.statusCode === HttpStatus.NotImplemented) {
                        // Continue to the next implementation
                        // eslint-disable-next-line no-continue
                        continue;
                    } else if (error.statusCode === HttpStatus.MethodNotAllowed) {
                        // The URL matches, but the method is not valid.
                        // Some other implementation might still accept this method,
                        // so continue iterating, or finally return this 405 if not found.
                        errorResponse = error;
                        // eslint-disable-next-line no-continue
                        continue;
                    } else {
                        // Raise through but with side-effect headers
                        throw applyResponseEffects(error, request.auth, effects, operations);
                    }
                }
                // Raise through
                throw error;
            }
        }
        // This should not be possible with API gateway, but possible with the local server
        return errorResponse;
    };

    public extend(controllers: Record<string, Controller>): ApiService {
        return new ApiService({ ...this.controllersByName, ...controllers });
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

function parseRequest<I>(operation: Operation<I, any, any>, request: HttpRequest): I {
    const { path, queryParameters, method, body, headers } = request;
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
    const { 'Content-Type': contentTypeHeader = 'application/json' } = headers;
    const payload = parsePayload(payloadSerializer, body ? body.toString() : '', contentTypeHeader);
    // TODO: Gather validation errors togeter?
    return { ...urlParameters, ...payload };
}

function applyResponseEffects(
    response: HttpResponse | ApiResponse,
    auth: UserSession | null,
    effects: ResourceEffect[],
    operations: Operation<any, any, any>[],
): HttpResponse | ApiResponse {
    if (!('data' in response)) {
        return response;
    }
    const changes = getSerializedStateEffectChanges(effects, operations, auth);
    return {
        ...response,
        data: {
            changes,
            ...response.data,
        },
    };
}
