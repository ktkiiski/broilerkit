import { RDSDataService } from 'aws-sdk';
import { Client, ClientBase, PoolClient } from 'pg';
import { Table } from './db';
import { EffectContext, ResourceEffect } from './effects';
import { HttpStatus } from './http';
import { scanCursor } from './postgres-cursor';
import { Resource } from './resources';
import { retry } from './retry';
import { formatSql, Row, SqlQuery, SqlResult, TableDefaults } from './sql';
import { isNotNully } from './utils/compare';

const verboseLogging = !process.env.AWS_LAMBDA_LOG_GROUP_NAME;

function logSql(sql: string, params?: any[]) {
    const msg = verboseLogging ? formatSql(sql, params) : sql;
    // tslint:disable-next-line:no-console
    console.debug(msg);
}

interface SqlScanChunk extends SqlResult {
    isComplete: boolean;
}

export interface Database {
    tables: Table[];
    defaultsByTable: TableDefaults;
    getAggregationQueries<S>(resource: Resource<S, any, any>, newValues: S | null, oldValues: S | null): Array<SqlOperation<any>>;
}

export interface SqlConnection extends EffectContext {
    query(sql: string, params?: any[]): Promise<SqlResult>;
    queryAll(queries: Array<{sql: string, params?: any[]}>): Promise<SqlResult[]>;
    scan(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<SqlScanChunk>;
    disconnect(error?: any): Promise<void>;
    transaction<R>(callback: () => Promise<R>): Promise<R>;
}

export type SqlOperation<R> = (connection: SqlConnection, db: Database) => Promise<R>;
export type SqlScanOperation<S> = (connection: SqlConnection, db: Database) => AsyncIterableIterator<S[]>;

abstract class BasePostgreSqlConnection<T extends ClientBase> {
    protected abstract client: T;
    private transactionCount = 0;
    private snapshotEffects: ResourceEffect[] = [];
    constructor(
        public readonly effects: ResourceEffect[],
    ) {}
    public async query(sql: string, params?: any[]): Promise<SqlResult> {
        if (sql === '') {
            return { rowCount: 0, rows: [] };
        }
        const { client } = this;
        logSql(sql, params);
        return client.query(sql, params);
    }
    public async queryAll(queries: Array<{ sql: string; params?: any[]; }>): Promise<SqlResult[]> {
        // TODO: Could probably be optimized as a single ';' separated query string in some cases
        const results: SqlResult[] = [];
        for (const { sql, params } of queries) {
            results.push(await this.query(sql, params));
        }
        return results;
    }
    public async *scan(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<SqlScanChunk> {
        if (sql === '') {
            return;
        }
        const { client } = this;
        logSql(sql, params);
        for await (const rows of scanCursor<Row>(client, chunkSize, sql, params)) {
            yield { rows, rowCount: rows.length, isComplete: rows.length < chunkSize };
        }
    }
    public abstract disconnect(error?: any): Promise<void>;
    public async transaction<R>(callback: () => Promise<R>): Promise<R> {
        this.transactionCount += 1;
        try {
            if (this.transactionCount === 1) {
                // Begin a new transaction
                return await this.newTransaction(callback);
            } else {
                // Already in a transaction
                return await callback();
            }
        } finally {
            this.transactionCount -= 1;
        }
    }
    private async newTransaction<R>(callback: () => Promise<R>): Promise<R> {
        // Serializable transactions must be retried on serialization errors
        return await retry(async () => {
            // Save the effects so far
            this.snapshotEffects = this.effects.slice();
            let result;
            // Begin the transaction
            await this.query(`BEGIN ISOLATION LEVEL SERIALIZABLE;`);
            let needsRollback = true;
            try {
                // Perform the operations
                result = await callback();
                needsRollback = false;
                // Commit the transaction
                await this.query(`COMMIT;`);
            } catch (error) {
                // There was an error.
                // Rollback the effects
                this.effects.length = 0;
                this.effects.push(...this.snapshotEffects);
                // Rollback the transaction
                if (needsRollback) {
                    await this.query(`ROLLBACK;`);
                }
                // Pass through the error, possibly starting a retry
                throw error;
            }
            return result;
        }, (error) => (
            // Retry the transaction on serialization and conflict errors
            String(error.code) === '40001' || error.statusCode === HttpStatus.Conflict
        ));
    }
}

export class PostgreSqlConnection extends BasePostgreSqlConnection<Client> implements SqlConnection {
    constructor(protected client: Client, effects: ResourceEffect[]) {
        super(effects);
    }
    public async disconnect(): Promise<void> {
        this.client.end();
    }
}

export class PostgreSqlPoolConnection extends BasePostgreSqlConnection<PoolClient> implements SqlConnection {
    constructor(protected client: PoolClient, effects: ResourceEffect[]) {
        super(effects);
    }
    public async disconnect(error?: any): Promise<void> {
        this.client.release(error);
    }
}

export class RemotePostgreSqlConnection implements SqlConnection {
    public readonly effects: ResourceEffect[] = [];
    private rdsDataApi?: RDSDataService = new RDSDataService({
        apiVersion: '2018-08-01',
        region: this.region,
    });
    constructor(
        private readonly region: string,
        private readonly resourceArn: string,
        private readonly secretArn: string,
        private readonly database: string,
    ) {}
    public async query(sql: string, params?: any[]): Promise<SqlResult> {
        if (sql === '') {
            return { rowCount: 0, rows: [] };
        }
        const { rdsDataApi, resourceArn, secretArn, database } = this;
        if (!rdsDataApi) {
            throw new Error(`Already disconnected from the database`);
        }
        const parameters: RDSDataService.SqlParameter[] = (params || [])
            .map(encodeDataApiFieldValue)
            .map((value, index) => ({ value, name: String(index + 1) }));
        const placeholderSql = sql.replace(/\$(\d+)/g, (_, index) => `:${index}`);
        const request = rdsDataApi.executeStatement({
            sql: placeholderSql,
            resourceArn, secretArn, database, parameters,
            includeResultMetadata: true,
        });
        const { columnMetadata, numberOfRecordsUpdated, records } = await request.promise();
        const rowCount = numberOfRecordsUpdated || 0;
        const columns = (columnMetadata || [])
            .map(({ name }) => name)
            .filter(isNotNully);
        const rows = (records || []).map((fields) => {
            const row: Row = {};
            columns.forEach((name, index) => {
                row[name] = decodeDataApiFieldValue(fields[index]);
            });
            return row;
        });
        return { rowCount, rows };
    }
    public async queryAll(queries: Array<{ sql: string; params?: any[]; }>): Promise<SqlResult[]> {
        const results: SqlResult[] = [];
        for (const { sql, params } of queries) {
            results.push(await this.query(sql, params));
        }
        return results;
    }
    public async *scan(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<SqlScanChunk> {
        if (sql === '') {
            return { rowCount: 0, rows: [] };
        }
        // The RDSDataService does not support cursors. For now, we just attempt
        // to retrieve everything, but this will fail when the data masses increase.
        const result = await this.query(sql, params);
        const allRows = result.rows.slice();
        while (allRows.length) {
            const rows = allRows.splice(0, chunkSize);
            yield { rows, rowCount: rows.length, isComplete: !allRows.length };
        }
    }
    public transaction(): never {
        throw new Error('Transactions not implemented.');
    }
    public async disconnect(): Promise<void> {
        delete this.rdsDataApi;
    }
}

export class DatabaseClient {

    constructor(
        private readonly db: Database | null,
        private readonly connect: () => Promise<SqlConnection>,
    ) {}

    /**
     * Executes a single database query or operation,
     * returning its result as a promise.
     * @param query database operation or query
     */
    public async run<T>(query: SqlOperation<T>) {
        const db = this.getDatabase();
        return this.withConnection((connection) => query(connection, db));
    }

    /**
     * Executes all the given database queries, failing as soon as any of them fails.
     * Note that unless run in a transaction, any failed operations are not rolled back,
     * and you won't get any intermediate results. Therefore it is recommended to either
     * only run read operations, or wrap the exeution in a transaction.
     * @param queries Array of database operations to execute
     */
    public async runAll<T1, T2, T3, T4, T5>(queries: [SqlQuery<T1>, SqlQuery<T2>, SqlQuery<T3>, SqlQuery<T4>, SqlQuery<T5>]): Promise<[T1, T2, T3, T4, T5]>;
    public async runAll<T1, T2, T3, T4>(queries: [SqlQuery<T1>, SqlQuery<T2>, SqlQuery<T3>, SqlQuery<T4>]): Promise<[T1, T2, T3, T4]>;
    public async runAll<T1, T2, T3>(queries: [SqlQuery<T1>, SqlQuery<T2>, SqlQuery<T3>]): Promise<[T1, T2, T3]>;
    public async runAll<T1, T2>(queries: [SqlQuery<T1>, SqlQuery<T2>]): Promise<[T1, T2]>;
    public async runAll<T1>(queries: [SqlQuery<T1>]): Promise<[T1]>;
    public async runAll<T>(queries: Array<SqlQuery<T>>): Promise<T[]>;
    public async runAll<T>(queries: Array<SqlQuery<T>>): Promise<T[]> {
        return this.withConnection(async (connection) => {
            const results = await connection.queryAll(queries);
            return queries.map((query, index) => query.deserialize(results[index]));
        });
    }

    /**
     * Executes an array of database operations or queries atomically in a transaction,
     * returning an array of results in corresponding order. Fails if any of the
     * operations fail, rolling back earlier results.
     * @param operations Array of database operations to execute
     */
    public async batch<T1, T2, T3, T4, T5>(queries: [SqlOperation<T1>, SqlOperation<T2>, SqlOperation<T3>, SqlOperation<T4>, SqlOperation<T5>]): Promise<[T1, T2, T3, T4, T5]>;
    public async batch<T1, T2, T3, T4>(queries: [SqlOperation<T1>, SqlOperation<T2>, SqlOperation<T3>, SqlOperation<T4>]): Promise<[T1, T2, T3, T4]>;
    public async batch<T1, T2, T3>(queries: [SqlOperation<T1>, SqlOperation<T2>, SqlOperation<T3>]): Promise<[T1, T2, T3]>;
    public async batch<T1, T2>(queries: [SqlOperation<T1>, SqlOperation<T2>]): Promise<[T1, T2]>;
    public async batch<T1>(queries: [SqlOperation<T1>]): Promise<[T1]>;
    public async batch<T>(queries: Array<SqlOperation<T>>): Promise<T[]>;
    public async batch<T>(operations: Array<SqlOperation<T>>): Promise<T[]> {
        const db = this.getDatabase();
        return this.withTransaction(async (connection) => {
            const results: T[] = [];
            for (const op of operations) {
                results.push(await op(connection, db));
            }
            return results;
        });
    }

    public async *scan<S>(query: SqlScanOperation<S>): AsyncIterableIterator<S[]> {
        const db = this.getDatabase();
        const connection = await this.connect();
        try {
            yield *query(connection, db);
        } finally {
            connection.disconnect();
        }
    }

    private async withConnection<R>(callback: (connection: SqlConnection) => Promise<R>): Promise<R> {
        const connection = await this.connect();
        try {
            return await callback(connection);
        } finally {
            connection.disconnect();
        }
    }

    private async withTransaction<R>(callback: (connection: SqlConnection) => Promise<R>): Promise<R> {
        return this.withConnection(async (connection) => (
            connection.transaction(() => callback(connection))
        ));
    }

    private getDatabase(): Database {
        if (!this.db) {
            throw new Error(`Database not configured`);
        }
        return this.db;
    }
}

export async function executeQuery<R>(connection: SqlConnection, query: SqlQuery<R>): Promise<R> {
    const result = await connection.query(query.sql, query.params);
    return query.deserialize(result);
}

export async function executeQueries<R>(connection: SqlConnection, queries: Array<SqlQuery<R>>): Promise<R[]> {
    const results: R[] = [];
    for (const query of queries) {
        const result = await connection.query(query.sql, query.params);
        results.push(query.deserialize(result));
    }
    return results;
}

function encodeDataApiFieldValue(value: unknown) {
    if (typeof value == null) {
        return { isNull: true };
    }
    if (typeof value === 'string') {
        return { stringValue: value };
    }
    if (typeof value === 'number') {
        return { doubleValue: value };
    }
    if (typeof value === 'boolean') {
        return { booleanValue: value };
    }
    throw new Error(`Unsupported parameter value ${value}`);
}

function decodeDataApiFieldValue(value: RDSDataService.Field) {
    if (value.isNull) {
        return null;
    }
    if (value.stringValue != null) {
        return value.stringValue as string;
    }
    if (value.doubleValue != null) {
        return value.doubleValue as number;
    }
    if (value.booleanValue != null) {
        return value.booleanValue as boolean;
    }
    if (value.longValue != null) {
        return value.longValue as number;
    }
    if (value.blobValue != null) {
        return value.blobValue.toString();
    }
    const { arrayValue } = value as any;
    if (arrayValue != null) {
        if (arrayValue.stringValues) {
            return arrayValue.stringValues as string[];
        }
        if (arrayValue.doubleValues) {
            return arrayValue.doubleValues as number[];
        }
        if (arrayValue.longValues) {
            return arrayValue.longValues as number[];
        }
        if (arrayValue.booleanValues) {
            return arrayValue.booleanValues as boolean[];
        }
    }
    throw new Error(`Unsupported field value: ${JSON.stringify(value)}`);
}
