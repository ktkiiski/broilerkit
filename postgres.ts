import { RDSDataService } from 'aws-sdk';
import { Client, ClientBase, PoolClient } from 'pg';
import { Identity, PartialUpdate, Query, TableDefinition } from './db';
import { HttpStatus, isResponse, NotFound, PreconditionFailed } from './http';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { scanCursor } from './postgres-cursor';
import { nestedList } from './serializers';
import { sort } from './utils/arrays';
import { hasProperties, isNotNully } from './utils/compare';
import { Exact, Key, keys, Nullable, transformValues } from './utils/objects';

interface SqlRequest {
    text: string;
    values: any[];
}

interface SqlResult<R> {
    rows: R[];
    rowCount: number;
}

export interface SqlConnection {
    query<R>(sql: string, params?: any[]): Promise<SqlResult<R>>;
    scan<R>(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<R[]>;
    disconnect(error?: any): Promise<void>;
}

abstract class BasePostgreSqlConnection<T extends ClientBase> {
    protected abstract client: T;
    public async query<R>(sql: string, params?: any[]): Promise<SqlResult<R>> {
        const { client } = this;
        return client.query<R>(sql, params);
    }
    public async *scan<R>(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<R[]> {
        const { client } = this;
        yield *scanCursor<R>(client, chunkSize, sql, params);
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
    public async query<R>(sql: string, params?: any[]): Promise<SqlResult<R>> {
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
            const row: Record<string, any> = {};
            columns.forEach((name, index) => {
                row[name] = decodeDataApiFieldValue(fields[index]);
            });
            return row as R;
        });
        return { rowCount, rows };
    }
    public async *scan<R>(chunkSize: number, sql: string, params?: any[]): AsyncIterableIterator<R[]> {
        // The RDSDataService does not support cursors. For now, we just attempt
        // to retrieve everything, but this will fail when the data masses increase.
        const result = await this.query<R>(sql, params);
        const rows = result.rows.slice();
        while (rows.length) {
            yield rows.splice(0, chunkSize);
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
        const queryConfig = this.selectQuery(table, filters, 1);
        const { rows } = await this.executeQuery<S>(queryConfig);
        return this.getValidatedRow(table, rows);
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
    ) {
        const insertedValues = table.resource.validate(item);
        const query = this.insertQuery(table, insertedValues);
        const aggregationQueries = this.getAggregationQueries(table, insertedValues, 1);
        const result = aggregationQueries.length
            ? await this.withTransaction(async (connection) => {
                const res = await connection.query<S>(query.text, query.values);
                if (!res.rows.length) {
                    // Fail and abort the transaction
                    throw new PreconditionFailed(`Item already exists.`);
                }
                // Update aggregations
                for (const { text, values } of aggregationQueries) {
                    await connection.query(text, values);
                }
                return res;
            })
            : await this.executeQuery<S>(query);
        return this.getValidatedRow(table, result.rows);
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
        const { resource } = table;
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const filters = identitySerializer.validate(identity);
        const values = resource.validate(item);
        // TODO: Update aggregations!
        const query = this.updateQuery(table, filters, values);
        const { rows } = await this.executeQuery<S>(query);
        return this.getValidatedRow(table, rows);
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
        // TODO: Update aggregations!
        const query = this.updateQuery(table, filters, values);
        const { rows } = await this.executeQuery<S>(query);
        return this.getValidatedRow(table, rows);
    }

    /**
     * Same than update, but instead resulting to the whole updated object,
     * only results to the changes given as parameter. Prefer this instead
     * of patch if you do not need to know all the up-to-date attributes of the
     * object after a successful patch, as this is more efficient.
     */
    public async amend<S, PK extends Key<S>, V extends Key<S>, D, C extends PartialUpdate<S, V>>(
        table: TableDefinition<S, PK, V, D>,
        identity: Identity<S, PK, V>,
        changes: C,
    ): Promise<C> {
        // TODO: Better performing implementation
        await this.update(table, identity, changes);
        return changes;
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
        const aggregationQueries = this.getAggregationQueries(table, insertValues, 1);
        const query = this.insertQuery(table, insertValues, updateValues);
        const result = aggregationQueries.length
            ? await this.withTransaction(async (connection) => {
                const res = await connection.query<S & {xmax: number}>(query.text, query.values);
                const { rows } = res;
                if (rows.length && rows[0].xmax === 0) {
                    // Row was actually inserted
                    // Update aggregations
                    for (const { text, values } of aggregationQueries) {
                        await connection.query(text, values);
                    }
                }
                return res;
            })
            : await this.executeQuery<S>(query);
        return this.getValidatedRow(table, result.rows);
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
        const query = this.deleteQuery(table, filters);
        const result = table.aggregations.length
            ? await this.withTransaction(async (connection) => {
                const res = await connection.query<S>(query.text, query.values);
                const { rows } = res;
                if (rows.length) {
                    // Row was actually deleted
                    // Update aggregations
                    const aggregationQueries = this.getAggregationQueries(table, rows[0], -1);
                    for (const { text, values } of aggregationQueries) {
                        await connection.query(text, values);
                    }
                }
                return res;
            })
            : await this.executeQuery<S>(query);
        if (!result.rowCount) {
            throw new NotFound(`Item was not found.`);
        }
    }

    /**
     * Deletes an item from the database if it exists in the database.
     * Unlike destroy, this does not fail if the item didn't exists.
     */
    public async clear<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        identity: Identity<S, PK, V>,
    ) {
        try {
            return await this.destroy(table, identity);
        } catch (error) {
            if (!isResponse(error, HttpStatus.NotFound)) {
                throw error;
            }
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
        const { ordering, direction, since, ...filters } = query;
        const results: S[] = [];
        const chunkSize = 100;
        for await (const items of this.scanChunks(table, chunkSize, filters, ordering, direction, since)) {
            results.push(...items.filter(isNotNully));
            if (items.length < chunkSize) {
                return { results, next: null };
            }
            const cursor = prepareForCursor(results, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: { ...query, since: cursor.since as any },
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
        for await (const chunk of iterator) {
            yield chunk.filter(isNotNully);
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
        const query = this.batchSelectQuery(table, filtersList);
        const { rows } = await this.executeQuery<S>(query);
        const items = rows.map((row) => validateRow(table, row));
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

    private async executeQuery<S>({ text, values }: SqlRequest) {
        return this.withConnection((connection) => connection.query<S>(text, values));
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
    ): AsyncIterableIterator<Array<null | S>> {
        const { text, values } = this.selectQuery(table, filters, undefined, ordering, direction, since);
        const connection = await this.connect();
        try {
            for await (const chunk of connection.scan<Nullable<S>>(chunkSize, text, values)) {
                yield chunk.map((row) => validateRow(table, row));
            }
        } finally {
            connection.disconnect();
        }
    }

    private selectQuery<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        filters: Record<string, any>,
        limit?: number,
        ordering?: string,
        direction?: 'asc' | 'desc',
        since?: any,
    ) {
        const params: any[] = [];
        const columnNames = Object.keys(table.resource.fields).map(escapeRef);
        let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(table.name)}`;
        const conditions = Object.keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        if (ordering && direction && since != null) {
            params.push(since);
            const dirOp = direction === 'asc' ? '>' : '<';
            conditions.push(`${escapeRef(ordering)} ${dirOp} $${params.length}`);
        }
        if (conditions.length) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        if (ordering && direction) {
            sql += ` ORDER BY ${escapeRef(ordering)} ${direction.toUpperCase()}`;
        }
        if (limit != null) {
            params.push(limit);
            sql += ` LIMIT $${params.length}`;
        }
        sql += ';';
        return { text: sql, values: params };
    }

    private batchSelectQuery<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        filtersList: Array<Record<string, any>>,
    ) {
        const params: any[] = [];
        const columnNames = Object.keys(table.resource.fields).map(escapeRef);
        let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(table.name)}`;
        const orConditions = filtersList.map((filters) => {
            const andConditions = keys(filters).map((filterKey) => {
                const filterValue = filters[filterKey];
                return makeComparison(filterKey, filterValue, params);
            });
            return `(${andConditions.join(' AND ')})`;
        });
        sql += ` WHERE ${orConditions.join(' OR ')};`;
        return { text: sql, values: params };
    }

    private updateQuery<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        filters: Record<string, any>,
        values: Record<string, any>,
    ) {
        const params: any[] = [];
        const assignments: string[] = [];
        const { fields, identifyBy } = table.resource;
        const columns = keys(fields);
        columns.forEach((key) => {
            const value = values[key];
            if (typeof value !== 'undefined' && !identifyBy.includes(key as PK)) {
                assignments.push(makeAssignment(key, value, params));
            }
        });
        const conditions = keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        const tblSql = escapeRef(table.name);
        const valSql = assignments.join(', ');
        const condSql = conditions.join(' AND ');
        const colSql = columns.map(escapeRef).join(', ');
        const sql = `UPDATE ${tblSql} SET ${valSql} WHERE ${condSql} RETURNING ${colSql};`;
        return { text: sql, values: params };
    }

    private insertQuery<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        insertValues: Record<string, any>,
        updateValues?: Record<string, any>,
    ) {
        const params: any[] = [];
        const columns: string[] = [];
        const placeholders: string[] = [];
        const updates: string[] = [];
        const { fields, identifyBy } = table.resource;
        keys(fields).forEach((key) => {
            columns.push(escapeRef(key));
            params.push(insertValues[key]);
            placeholders.push(`$${params.length}`);
        });
        if (updateValues) {
            keys(updateValues).forEach((key) => {
                updates.push(makeAssignment(key, updateValues[key], params));
            });
        }
        const tblSql = escapeRef(table.name);
        const colSql = columns.join(', ');
        const valSql = placeholders.join(', ');
        let sql = `INSERT INTO ${tblSql} (${colSql}) VALUES (${valSql})`;
        if (updates.length) {
            const pkSql = identifyBy.map(escapeRef).join(',');
            const upSql = updates.join(', ');
            sql += ` ON CONFLICT (${pkSql}) DO UPDATE SET ${upSql}`;
        } else {
            sql += ` ON CONFLICT DO NOTHING`;
        }
        sql += ` RETURNING ${colSql}, xmax::text::int;`;
        return { text: sql, values: params };
    }

    private deleteQuery<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>,
        filters: Record<string, any>,
    ) {
        const { fields } = table.resource;
        const params: any[] = [];
        const colSql = keys(fields).map(escapeRef).join(', ');
        let sql = `DELETE FROM ${escapeRef(table.name)}`;
        const conditions = Object.keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        if (conditions.length) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        sql += ` RETURNING ${colSql};`;
        return { text: sql, values: params };
    }

    private getValidatedRow<S, PK extends Key<S>>(table: TableDefinition<S, PK, any, any>, rows: S[]) {
        if (!rows.length) {
            throw new NotFound(`Item was not found.`);
        }
        const row = validateRow(table, rows[0]);
        if (!row) {
            throw new NotFound(`Item found but was corrupted.`);
        }
        return row;
    }

    private getAggregationQueries<S, PK extends Key<S>, V extends Key<S>, D>(
        table: TableDefinition<S, PK, V, D>, values: S, diff: number,
    ) {
        // NOTE: Sorting by aggregation table names to ensure a consistent
        // order that minimizes possibility for deadlocks.
        const aggregations = sort(table.aggregations, (agg) => agg.target.name);
        return aggregations.map((aggregation) => (
            this.updateQuery(
                aggregation.target,
                transformValues(aggregation.by, (field) => values[field]),
                {[aggregation.field]: increment(diff)},
            )
        ));
    }
}

class Increment {
    constructor(public readonly diff: number) {}
}

function increment(diff: number) {
    return new Increment(diff);
}

function validateRow<S, PK extends Key<S>>(table: TableDefinition<S, PK, any, any>, item: Nullable<S>): S | null {
    const { defaults, resource } = table;
    const result = Object.keys(defaults).reduce(
        (obj, key) => {
            const defaultValue = defaults[key];
            if (obj[key as keyof S] == null && defaultValue != null) {
                return { ...obj, [key]: defaultValue };
            }
            return obj;
        },
        item,
    );
    try {
        return resource.validate(result as S);
    } catch (error) {
        // The database entry is not valid!
        const identity: {[key: string]: any} = {};
        resource.identifyBy.forEach((key) => {
            identity[key] = result[key];
        });
        // tslint:disable-next-line:no-console
        console.error(`Failed to load invalid record ${JSON.stringify(identity)} from the database:`, error);
        return null;
    }
}

function makeAssignment(field: string, value: any, params: any[]): string {
    if (value instanceof Increment) {
        // Make an increment statement
        params.push(value.diff);
        return `${escapeRef(field)} = COALESCE(${escapeRef(field)}, 0) + $${params.length}`;
    }
    params.push(value);
    return `${escapeRef(field)} = $${params.length}`;
}

function makeComparison(field: string, value: any, params: any[]): string {
    if (value == null) {
        return `${escapeRef(field)} IS NULL`;
    }
    if (Array.isArray(value)) {
        if (!value.length) {
            // would result in `xxxx IN ()` which won't work
            return `FALSE`;
        }
        const placeholders = value.map((item) => {
            params.push(item);
            return `$${params.length}`;
        });
        return `${escapeRef(field)} IN (${placeholders.join(',')})`;
    }
    params.push(value);
    return `${escapeRef(field)} = $${params.length}`;
}

function escapeRef(identifier: string) {
    return JSON.stringify(identifier);
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
