import { RDSDataService } from 'aws-sdk';
import { Identity, ModelContext, PartialUpdate, Query, VersionedModel } from './db';
import { NotFound, PreconditionFailed } from './http';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { scanCursor } from './postgres-cursor';
import { Resource } from './resources';
import { nestedList } from './serializers';
import { hasProperties, isNotNully } from './utils/compare';
import { Exact, Key, keys } from './utils/objects';

interface SqlRequest {
    text: string;
    values: any[];
}

interface SqlResult<R extends Record<string, any>> {
    rows: R[];
    rowCount: number;
}

abstract class BasePostgreSqlDbModel<S, PK extends Key<S>, V extends Key<S>, D>
implements VersionedModel<S, PK, V, D> {

    protected readonly updateSerializer = this.serializer.partial([this.serializer.versionBy]);
    protected readonly identitySerializer = this.serializer.pick([
        ...this.serializer.identifyBy,
        this.serializer.versionBy,
    ]).partial(this.serializer.identifyBy);

    constructor(
        protected readonly tableName: string,
        public readonly serializer: Resource<S, PK, V>,
    ) {}

    public async retrieve(query: Identity<S, PK, V>) {
        const { identitySerializer } = this;
        const filters = identitySerializer.validate(query);
        const queryConfig = this.selectQuery(filters, 1);
        const { rows } = await this.executeQuery(queryConfig);
        if (rows.length) {
            return rows[0];
        }
        throw new NotFound(`Item was not found.`);
    }

    public async create(item: S) {
        const { serializer } = this;
        const values = serializer.validate(item);
        const query = this.insertQuery(values);
        const { rows } = await this.executeQuery(query);
        if (!rows.length) {
            throw new PreconditionFailed(`Item already exists.`);
        }
        return rows[0];
    }

    public async replace(identity: Identity<S, PK, V>, item: S) {
        const { identitySerializer, serializer } = this;
        const filters = identitySerializer.validate(identity);
        const values = serializer.validate(item);
        const query = this.updateQuery(filters, values);
        const { rows } = await this.executeQuery(query);
        if (!rows.length) {
            throw new NotFound(`Item was not found.`);
        }
        return rows[0];
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>): Promise<S> {
        const { identitySerializer, updateSerializer } = this;
        const filters = identitySerializer.validate(identity);
        const values = updateSerializer.validate(changes);
        const query = this.updateQuery(filters, values);
        const { rows } = await this.executeQuery(query);
        if (!rows.length) {
            throw new NotFound(`Item was not found.`);
        }
        return rows[0];
    }

    public async amend<C extends PartialUpdate<S, V>>(identity: Identity<S, PK, V>, changes: C): Promise<C> {
        // TODO: Better performing implementation
        await this.update(identity, changes);
        return changes;
    }

    public async write(item: S): Promise<S> {
        return this.upsert(item, item);
    }

    public async upsert(creation: S, update: PartialUpdate<S, V>): Promise<S> {
        const { serializer, updateSerializer } = this;
        const insertValues = serializer.validate(creation);
        const updateValues = updateSerializer.validate(update);
        const query = this.insertQuery(insertValues, updateValues);
        const { rows } = await this.executeQuery<S>(query);
        return rows[0];
    }

    public async destroy(identity: Identity<S, PK, V>): Promise<void> {
        const { identitySerializer } = this;
        const filters = identitySerializer.validate(identity);
        const query = this.deleteQuery(filters);
        const result = await this.executeQuery(query);
        if (!result.rowCount) {
            throw new NotFound(`Item was not found.`);
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        const { identitySerializer } = this;
        const filters = identitySerializer.validate(identity);
        const query = this.deleteQuery(filters);
        await this.executeQuery(query);
    }

    public abstract async list<Q extends D & OrderedQuery<S, Key<S>>>(query: Exact<Q, D>): Promise<Page<S, Q>>;
    public abstract scan(query?: Query<S>): AsyncIterableIterator<S[]>;

    public async batchRetrieve(identities: Array<Identity<S, PK, V>>): Promise<Array<S | null>> {
        if (!identities.length) {
            return [];
        }
        const { identitySerializer } = this;
        const identityListSerializer = nestedList(identitySerializer);
        const filtersList = identityListSerializer.validate(identities);
        const query = this.batchSelectQuery(filtersList);
        const { rows } = await this.executeQuery(query);
        return filtersList.map((identity) => (
            rows.find((item) => hasProperties(item, identity)) || null
        ));
    }

    protected abstract async executeQuery<T = S>(queryConfig: SqlRequest): Promise<SqlResult<T>>;

    protected selectQuery(
        filters: Record<string, any>,
        limit?: number,
        ordering?: string,
        direction?: 'asc' | 'desc',
        since?: any,
    ) {
        const params: any[] = [];
        const columnNames = Object.keys(this.serializer.fields).map(escapeRef);
        let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(this.tableName)}`;
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

    protected batchSelectQuery(filtersList: Array<Record<string, any>>) {
        const params: any[] = [];
        const columnNames = Object.keys(this.serializer.fields).map(escapeRef);
        let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(this.tableName)}`;
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

    protected updateQuery(
        filters: Record<string, any>,
        values: Record<string, any>,
    ) {
        const { serializer, tableName } = this;
        const params: any[] = [];
        const assignments: string[] = [];
        const { fields } = serializer;
        const columnNames = Object.keys(fields).map(escapeRef);
        const conditions = keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        keys(fields).forEach((key) => {
            if (!this.serializer.identifyBy.includes(key as PK)) {
                assignments.push(makeAssignment(key, values[key], params));
            }
        });
        const tblSql = escapeRef(tableName);
        const valSql = assignments.join(', ');
        const condSql = conditions.join(' AND ');
        const colSql = columnNames.join(', ');
        const sql = `UPDATE ${tblSql} SET ${valSql} WHERE ${condSql} RETURNING ${colSql};`;
        return { text: sql, values: params };
    }

    protected insertQuery(
        insertValues: Record<string, any>,
        updateValues?: Record<string, any>,
    ) {
        const params: any[] = [];
        const columns: string[] = [];
        const placeholders: string[] = [];
        const updates: string[] = [];
        const { serializer, tableName } = this;
        const { fields, identifyBy } = serializer;
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
        const tblSql = escapeRef(tableName);
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
        sql += ` RETURNING ${colSql};`;
        return { text: sql, values: params };
    }

    protected deleteQuery(filters: Record<string, any>) {
        const params: any[] = [];
        let sql = `DELETE FROM ${escapeRef(this.tableName)}`;
        const conditions = Object.keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        if (conditions.length) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }
        sql += ';';
        return { text: sql, values: params };
    }
}

export class PostgreSqlDbModel<S, PK extends Key<S>, V extends Key<S>, D>
extends BasePostgreSqlDbModel<S, PK, V, D>
implements VersionedModel<S, PK, V, D> {

    constructor(
        private readonly context: ModelContext,
        tableName: string,
        serializer: Resource<S, PK, V>,
    ) {
        super(tableName, serializer);
    }

    public async list<Q extends D & OrderedQuery<S, Key<S>>>(query: Exact<Q, D>): Promise<Page<S, Q>> {
        const { ordering, direction, since, ...filters } = query;
        const results: S[] = [];
        const chunkSize = 100;
        for await (const items of this.scanChunks(chunkSize, filters, ordering, direction, since)) {
            results.push(...items);
            if (items.length < chunkSize) {
                return { results: items, next: null };
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

    public scan(query?: Query<S>): AsyncIterableIterator<S[]> {
        const chunkSize = 100;
        if (query) {
            const { ordering, direction, since, ...filters } = query;
            return this.scanChunks(chunkSize, filters, ordering, direction, since);
        } else {
            return this.scanChunks(chunkSize, {});
        }
    }

    protected async executeQuery<T = S>(queryConfig: SqlRequest) {
        const client = await this.context.connect();
        return client.query<T>(queryConfig);
    }

    private async *scanChunks(chunkSize: number, filters: Record<string, any>, ordering?: string, direction?: 'asc' | 'desc', since?: any) {
        const { text, values } = this.selectQuery(filters, undefined, ordering, direction, since);
        const client = await this.context.connect();
        yield *scanCursor<S>(client, chunkSize, text, values);
    }
}

export class RemotePostgreSqlDbModel<S, PK extends Key<S>, V extends Key<S>, D>
extends BasePostgreSqlDbModel<S, PK, V, D>
implements VersionedModel<S, PK, V, D> {

    private rdsDataApi = new RDSDataService({
        apiVersion: '2018-08-01',
        region: this.region,
    });

    constructor(
        private readonly region: string,
        private readonly resourceArn: string,
        private readonly secretArn: string,
        private readonly database: string,
        tableName: string,
        serializer: Resource<S, PK, V>,
    ) {
        super(tableName, serializer);
    }

    public async list<Q extends D & OrderedQuery<S, Key<S>>>(query: Exact<Q, D>): Promise<Page<S, Q>> {
        const { ordering, direction, since, ...filters } = query;
        let chunkSize = 100;
        while (true) {
            const sqlQuery = this.selectQuery(filters, chunkSize, ordering, direction, since);
            const { rows } = await this.executeQuery(sqlQuery);
            if (rows.length < chunkSize) {
                return { results: rows, next: null };
            }
            const cursor = prepareForCursor(rows, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: { ...query, since: cursor.since as any },
                };
            }
            // Need to increase the chunk size
            chunkSize *= 2;
        }
    }

    public async *scan(query?: Query<S>): AsyncIterableIterator<S[]> {
        let cursor: Query<S> | null = query || {
            ordering: 'id' as Key<S>,
            direction: 'asc',
        };
        while (cursor) {
            const { results, next }: Page<S, any> = await this.list(cursor as any);
            if (results.length) {
                yield results;
            }
            cursor = next;
        }
    }

    protected async executeQuery<T = S>(queryConfig: SqlRequest) {
        const { resourceArn, secretArn, database } = this;
        const sql = queryConfig.text;
        const parameters = buildDataApiParameters(queryConfig.values);
        const request = this.rdsDataApi.executeStatement({
            resourceArn, secretArn, database, sql, parameters,
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
            return row as T;
        });
        return { rowCount, rows };
    }
}

function makeAssignment(field: string, value: any, params: any[]): string {
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

function buildDataApiParameters(values: unknown[]): RDSDataService.SqlParameter[] {
    return values.map(encodeDataApiFieldValue).map((value) => ({ value }));
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
        return value.stringValue;
    }
    if (value.doubleValue != null) {
        return value.doubleValue;
    }
    if (value.booleanValue != null) {
        return value.booleanValue;
    }
    if (value.longValue != null) {
        return value.longValue;
    }
    if (value.blobValue != null) {
        return value.blobValue.toString();
    }
    throw new Error(`Unsupported field value: ${JSON.stringify(value)}`);
}
