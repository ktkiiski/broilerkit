import { RDSDataService } from 'aws-sdk';
import { Client, ClientBase, PoolClient } from 'pg';
import { Identity, PartialUpdate, Query, TableDefinition } from './db';
import { NotFound, PreconditionFailed } from './http';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { scanCursor } from './postgres-cursor';
import { nestedList } from './serializers';
import { batchSelectQuery, deleteQuery, increment, insertQuery, Row, selectQuery, SqlQuery, SqlResult, updateQuery } from './sql';
import { sort } from './utils/arrays';
import { hasProperties, isNotNully } from './utils/compare';
import { Exact, Key, transformValues } from './utils/objects';

interface SqlScanChunk extends SqlResult {
    isComplete: boolean;
}

export interface SqlConnection {
    query(sql: string, params?: any[]): Promise<SqlResult>;
    scan(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<SqlScanChunk>;
    disconnect(error?: any): Promise<void>;
}

abstract class BasePostgreSqlConnection<T extends ClientBase> {
    protected abstract client: T;
    public async query(sql: string, params?: any[]): Promise<SqlResult> {
        const { client } = this;
        return client.query(sql, params);
    }
    public async *scan(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<SqlScanChunk> {
        const { client } = this;
        for await (const rows of scanCursor<Row>(client, chunkSize, sql, params)) {
            yield { rows, rowCount: rows.length, isComplete: rows.length < chunkSize };
        }
    }
    public abstract disconnect(error?: any): Promise<void>;
}

export class PostgreSqlConnection extends BasePostgreSqlConnection<Client> implements SqlConnection {
    constructor(protected client: Client) {
        super();
    }
    public async disconnect(): Promise<void> {
        this.client.end();
    }
}

export class PostgreSqlPoolConnection extends BasePostgreSqlConnection<PoolClient> implements SqlConnection {
    constructor(protected client: PoolClient) {
        super();
    }
    public async disconnect(error?: any): Promise<void> {
        this.client.release(error);
    }
}

export class RemotePostgreSqlConnection implements SqlConnection {

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
    public async *scan(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<SqlScanChunk> {
        // The RDSDataService does not support cursors. For now, we just attempt
        // to retrieve everything, but this will fail when the data masses increase.
        const result = await this.query(sql, params);
        const allRows = result.rows.slice();
        while (allRows.length) {
            const rows = allRows.splice(0, chunkSize);
            yield { rows, rowCount: rows.length, isComplete: !allRows.length };
        }
    }
    public async disconnect(): Promise<void> {
        delete this.rdsDataApi;
    }
}

export class DatabaseClient {

    constructor(
        private readonly connect: () => Promise<SqlConnection>,
    ) {}

    /**
     * Gets an item from the database table using the given identity
     * object, containing all the identifying attributes.
     *
     * It results to an error if the item is not found.
     * Optionally the error object may be given as an attribute.
     *
     * Results to the item object, with all of its attributes,
     * if found successfully.
     */
    public async retrieve<S, PK extends Key<S>, V extends Key<S>, D>(table: TableDefinition<S, PK, V, D>, query: Identity<S, PK, V>) {
        const { resource } = table;
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const filters = identitySerializer.validate(query);
        const queryConfig = selectQuery(table, filters, 1);
        const [result] = await this.executeQuery(queryConfig);
        if (!result) {
            throw new NotFound(`Item was not found.`);
        }
        return result;
    }

    /**
     * Inserts an item with the given ID to the database table,
     * The given item must contain all resource attributes, including
     * the identifying attributes and the version attribute.
     *
     * It results to an error if an item with the same identifying
     * attributes already exists in the database.
     *
     * Results to the given item object if inserted successfully.
     */
    public async create<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        item: S,
    ): Promise<S> {
        const insertedValues = table.resource.validate(item);
        const query = insertQuery(table, insertedValues);
        const aggregationQueries = this.getAggregationQueries(table, insertedValues, null);
        const result = aggregationQueries.length
            ? await this.withTransaction(async (connection) => {
                const res = await connection.query(query.sql, query.params);
                const createdItem = query.deserialize(res);
                if (createdItem) {
                    // Update aggregations
                    await queryAll(connection, aggregationQueries);
                }
                return createdItem;
            })
            : await this.executeQuery(query);
        if (!result) {
            throw new PreconditionFailed(`Item already exists.`);
        }
        return result.item;
    }

    /**
     * Replaces an existing item in the database table, identified by the given
     * identity object. The given item object must contain all model attributes,
     * including the identifying attributes and the new version attribute.
     *
     * NOTE: It is an error to attempt changing identifying attributes!
     *
     * The identity may optionally include the version attribute.
     * In this case, the update is done only if the existing item's version
     * matches the version in the identity object. This allows making
     * non-conflicting updates.
     *
     * It results to an error if an item does not exist. Also fails if the
     * existing item's version does not match any given version.
     *
     * Results to the updated item object if inserted successfully.
     */
    public async replace<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        identity: Identity<S, PK, V>,
        item: S,
    ) {
        // Perform an update, but require all the resource properties
        const { resource } = table;
        resource.validate(item);
        return this.update(table, identity, item);
    }

    /**
     * Updates some of the attributes of an existing item in the database,
     * identified by the given identity object. The changes must contain
     * the version attribute, and any sub-set of the other attributes.
     *
     * NOTE: It is an error to attempt changing identifying attributes!
     *
     * The identity may optionally include the version attribute.
     * In this case, the update is done only if the existing item's version
     * matches the version in the identity object. This allows making
     * non-conflicting updates.
     *
     * Fails if the item does not exist. Also fails if the
     * existing item's version does not match any given version.
     *
     * Results to the updated item object with all up-to-date attributes,
     * if updated successfully.
     */
    public async update<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        identity: Identity<S, PK, V>,
        changes: PartialUpdate<S, V>,
    ): Promise<S> {
        const { resource } = table;
        const updateSerializer = resource.partial([resource.versionBy]);
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const filters = identitySerializer.validate(identity);
        const values = updateSerializer.validate(changes);
        const [result] = table.aggregate.length
            ? await this.withTransaction(async (connection) => {
                const query = updateQuery(table, filters, values, true);
                const res = await connection.query(query.sql, query.params);
                const updates = query.deserialize(res);
                for (const [newItem, oldItem] of updates) {
                    // Row was actually updated
                    // Update aggregations
                    const aggregationQueries = this.getAggregationQueries(table, newItem, oldItem);
                    await queryAll(connection, aggregationQueries);
                    return [newItem];
                }
                return [];
            })
            : await this.executeQuery(
                updateQuery(table, filters, values, false),
            );
        if (!result) {
            throw new NotFound(`Item was not found.`);
        }
        return result;
    }

    /**
     * Inserts a new item to the database, or updates an existing item
     * if one already exists with the same identity.
     *
     * NOTE: It is an error to attempt changing identifying attributes!
     *
     * The identity may optionally include the version attribute.
     * In this case, the update is done only if the existing item's version
     * matches the version in the identity object. This allows making
     * non-conflicting updates.
     *
     * Results to the created/updated item.
     */
    public async upsert<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        creation: S,
        update: PartialUpdate<S, V>,
    ): Promise<S> {
        const { resource } = table;
        const updateSerializer = resource.partial([resource.versionBy]);
        const insertValues = resource.validate(creation);
        const updateValues = updateSerializer.validate(update);
        const aggregationQueries = this.getAggregationQueries(table, insertValues, null);
        const query = insertQuery(table, insertValues, updateValues);
        const { item } = aggregationQueries.length
            ? await this.withTransaction(async (connection) => {
                const res = await connection.query(query.sql, query.params);
                const insertion = query.deserialize(res);
                if (insertion.wasCreated) {
                    // Row was actually inserted
                    // Update aggregations
                    await queryAll(connection, aggregationQueries);
                }
                return insertion;
            })
            : await this.executeQuery(query);
        return item;
    }

    /**
     * Either creates an item or replaces an existing one.
     * Use this instead of create/put method if you don't care if the
     * item already existed in the database.
     *
     * Results to the given item object if written successfully.
     */
    public async write<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        item: S,
    ): Promise<S> {
        return this.upsert(table, item, item);
    }

    /**
     * Deletes an item from the database, identified by the given
     * identity object. Fails if the item does not exists.
     */
    public async destroy<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        identity: Identity<S, PK, V>,
    ): Promise<void> {
        const { resource } = table;
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const filters = identitySerializer.validate(identity);
        const query = deleteQuery(table, filters);
        const result = table.aggregations.length
            ? await this.withTransaction(async (connection) => {
                const res = await connection.query(query.sql, query.params);
                const item = query.deserialize(res);
                if (item) {
                    // Row was actually deleted
                    // Update aggregations
                    const aggregationQueries = this.getAggregationQueries(table, null, item);
                    await queryAll(connection, aggregationQueries);
                }
                return item;
            })
            : await this.executeQuery(query);
        if (!result) {
            throw new NotFound(`Item was not found.`);
        }
    }

    /**
     * Queries and finds the first/next batch of items from the table
     * matching the given criteria.
     *
     * The return value is a page object containing an array of items,
     * and the `query` parameter for retrieving the next batch, or null
     * if no more items are expected to be found.
     */
    public async list<S, PK extends Key<S>, V extends Key<S>, D, Q extends D & OrderedQuery<S, Key<S>>>(
        table: TableDefinition<S, PK, V, D>,
        query: Exact<Q, D>,
    ): Promise<Page<S, Q>> {
        const { ordering, direction, since, ...filters } = query as Q;
        const results: S[] = [];
        const chunkSize = 100;
        for await (const chunk of this.scanChunks(table, chunkSize, filters, ordering, direction, since)) {
            const { items, isComplete } = chunk;
            results.push(...items);
            if (isComplete) {
                return { results, next: null };
            }
            const cursor = prepareForCursor(results, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: { ...query as Q, since: cursor.since as any },
                };
            }
        }
        // No more items
        return { results, next: null };
    }

    /**
     * Iterate over batches of items from the table matching the given criteria.
     *
     * Without parameters should scan the whole table, in no particular order.
     */
    public async *scan<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>, query?: Query<S>,
    ): AsyncIterableIterator<S[]> {
        const chunkSize = 100;
        let iterator;
        if (query) {
            const { ordering, direction, since, ...filters } = query;
            iterator = this.scanChunks(table, chunkSize, filters, ordering, direction, since);
        } else {
            iterator = this.scanChunks(table, chunkSize, {});
        }
        for await (const { items } of iterator) {
            yield items;
        }
    }

    /**
     * Retrieves item for each of the identity given objects, or null values if no
     * matching item is found, in the most efficient way possible. The results
     * from the returned promise are in the same order than the identities.
     */
    public async batchRetrieve<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        identities: Array<Identity<S, PK, V>>,
    ): Promise<Array<S | null>> {
        if (!identities.length) {
            return [];
        }
        const { resource } = table;
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const identityListSerializer = nestedList(identitySerializer);
        const filtersList = identityListSerializer.validate(identities);
        const query = batchSelectQuery(table, filtersList);
        const items = await this.executeQuery(query);
        return filtersList.map((identity) => (
            items.find((item) => item && hasProperties(item, identity)) || null
        ));
    }

    private async withConnection<R>(callback: (connection: SqlConnection) => Promise<R>): Promise<R> {
        const connection = await this.connect();
        try {
            return await callback(connection);
        } finally {
            connection.disconnect();
        }
    }

    private async executeQuery<R>(query: SqlQuery<R>): Promise<R> {
        const result = await this.withConnection(
            (connection) => connection.query(query.sql, query.params),
        );
        return query.deserialize(result);
    }

    private async withTransaction<R>(callback: (connection: SqlConnection) => Promise<R>): Promise<R> {
        return this.withConnection(async (connection) => {
            let result;
            try {
                await connection.query('BEGIN');
                result = await callback(connection);
            } catch (error) {
                // Something went wrong. Rollback the transaction
                await connection.query('ROLLBACK');
                throw error;
            }
            // Commit the transaction
            await connection.query('COMMIT');
            return result;
        });
    }

    private async *scanChunks<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        chunkSize: number,
        filters: Record<string, any>,
        ordering?: string,
        direction?: 'asc' | 'desc',
        since?: any,
    ): AsyncIterableIterator<{items: S[], isComplete: boolean}> {
        const query = selectQuery(table, filters, undefined, ordering, direction, since);
        const connection = await this.connect();
        try {
            for await (const chunk of connection.scan(chunkSize, query.sql, query.params)) {
                const items = query.deserialize(chunk);
                yield { items, isComplete: chunk.isComplete };
            }
        } finally {
            connection.disconnect();
        }
    }

    private getAggregationQueries<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>, newValues: S | null, oldValues: S | null,
    ) {
        const idValues = newValues || oldValues;
        if (!idValues) {
            // Both parameters are null
            return [];
        }
        // NOTE: Sorting by aggregation table names to ensure a consistent
        // order that minimizes possibility for deadlocks.
        const aggregations = sort(table.aggregations, (agg) => agg.target.name);
        return aggregations.map(({ target, by, field, filters }) => {
            const identifier = transformValues(by, (pk) => idValues[pk]);
            const mask = { ...filters, ...identifier };
            const isMatching = newValues != null && hasProperties(newValues, mask);
            const wasMatching = oldValues != null && hasProperties(oldValues, mask);
            const diff = (isMatching ? 1 : 0) - (wasMatching ? 1 : 0);
            if (diff === 0) {
                return null;
            }
            return updateQuery(target, identifier, {[field]: increment(diff)});
        }).filter(isNotNully);
    }
}

async function queryAll<R>(connection: SqlConnection, queries: Array<SqlQuery<R>>): Promise<R[]> {
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
