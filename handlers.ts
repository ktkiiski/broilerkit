import { CognitoUserPool, DummyUserPool, LocalUserPool, UserPool } from './cognito';
import type { EffectContext } from './effects';
import { DatabaseClient, PostgreSqlPoolConnection } from './postgres';
import type { ServerContext } from './server';
import type { FileStorage } from './storage';

export interface HandlerServerContext extends ServerContext, EffectContext {}

export interface HandlerContext extends EffectContext {
    /**
     * Database client for reading and modifying the data.
     */
    db: DatabaseClient;
    /**
     * Storage client for accessing and writing file data.
     */
    storage: FileStorage;
    /**
     * User pool client for accessing user information.
     */
    users: UserPool;
    /**
     * Stage-specific environment configuration
     */
    environment: { [variable: string]: string };
}

export type Handler<I, O, R> = (input: I, request: R & HandlerContext) => Promise<O>;

export async function executeHandler<I, O, R>(
    handler: Handler<I, O, R>,
    input: I,
    serverContext: HandlerServerContext,
    inputContext: R,
): Promise<O> {
    const { db, dbConnectionPool, effects, storage, userPoolId, region, environment } = serverContext;
    const dbClient = new DatabaseClient(db, async () => {
        if (!dbConnectionPool) {
            throw new Error(`Database is not configured`);
        }
        const client = await dbConnectionPool.connect();
        return new PostgreSqlPoolConnection(client, serverContext.effects);
    });
    const users: UserPool =
        // eslint-disable-next-line no-nested-ternary
        region === 'local'
            ? new LocalUserPool(dbClient)
            : userPoolId
            ? new CognitoUserPool(userPoolId, region)
            : new DummyUserPool();
    // TODO: Even though the client should always close the connection,
    // we should here ensure that all connections are released.
    const context: R & HandlerContext = {
        ...inputContext,
        db: dbClient,
        users,
        effects,
        storage,
        environment,
    };
    return handler(input, context);
}
