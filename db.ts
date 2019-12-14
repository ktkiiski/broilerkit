import { NotFound, PreconditionFailed } from './http';
import { TableState } from './migration';
import { OrderedQuery, PageResponse, prepareForCursor } from './pagination';
import { Database, executeQuery, SqlConnection, SqlOperation, SqlScanOperation, withTransaction } from './postgres';
import { Resource } from './resources';
import { nestedList } from './serializers';
import { batchSelectQuery, countQuery, deleteQuery, increment, Increment, insertQuery, selectQuery, TableDefaults, updateQuery } from './sql';
import { sort } from './utils/arrays';
import { hasProperties, isNotNully } from './utils/compare';
import { FilteredKeys, Key, pickBy, Require, transformValues } from './utils/objects';

export type Filters<T> = {[P in keyof T]?: T[P] | Array<T[P]>};
export type Query<T> = (OrderedQuery<T, Key<T>> & Filters<T>) | OrderedQuery<T, Key<T>>;
export type IndexQuery<T, Q extends keyof T, O extends keyof T> = {[P in Q]: T[P] | Array<T[P]>} & OrderedQuery<T, O> & Filters<T>;

export type Identity<S, PK extends Key<S>, V extends Key<S>> = (Pick<S, PK | (V extends undefined ? never : V)> | Pick<S, PK>) & Partial<S>;
export type PartialUpdate<S, V extends Key<S>> = Require<S, V>;

export interface Table<S = any, PK extends Key<S> = any, V extends Key<S> = any> {
    resource: Resource<S, PK, V>;
    getState(): TableState;
}

/**
 * Returns a database operation that gets an item from the
 * database table using the given identity object, containing
 * all the identifying attributes.
 * It results to an error if the item was not found.
 */
export function retrieve<S, PK extends Key<S>, V extends Key<S>>(
    resource: Resource<S, PK, V>,
    query: Identity<S, PK, V>,
): SqlOperation<S> {
    const { identifyBy, versionBy } = resource;
    const identitySerializer = versionBy.length
        ? resource
            .pick([...identifyBy, ...versionBy])
            .partial(identifyBy)
        : resource
            .pick(identifyBy);
    const filters = identitySerializer.validate(query);
    return async (connection, db) => {
        const select = selectQuery(resource, db.defaultsByTable, filters, 1);
        const [item] = await executeQuery(connection, select);
        if (!item) {
            throw new NotFound(`Item was not found.`);
        }
        return item;
    };
}

/**
 * Return a database opeartion that queries and finds the first/next batch
 * of items from the table matching the given criteria.
 *
 * The return value is a page object containing an array of items,
 * and the `query` parameter for retrieving the next batch, or null
 * if no more items are expected to be found.
 */
export function list<S>(
    resource: Resource<S, any, any>,
    query: Query<S>,
): SqlOperation<PageResponse<S>> {
    const results: S[] = [];
    const { ordering, direction, since, ...filters } = query;
    const chunkSize = 100;
    return async (connection, db) => {
        const select = selectQuery(resource, db.defaultsByTable, filters, undefined, ordering, direction, since);
        for await (const chunk of connection.scan(chunkSize, select.sql, select.params)) {
            const items = select.deserialize(chunk);
            results.push(...items);
            if (chunk.isComplete) {
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
    };
}

/**
 * Returns a database scan query for iterating over batches of items from the
 * table matching the given criteria.
 *
 * Without parameters should scan the whole table, in no particular order.
 */
export function scan<S>(
    resource: Resource<S, any, any>,
    query?: Query<S>,
): SqlScanOperation<S> {
    const chunkSize = 100;
    return async function *(connection, db) {
        let select;
        if (query) {
            const { ordering, direction, since, ...filters } = query;
            select = selectQuery(resource, db.defaultsByTable, filters, undefined, ordering, direction, since);
        } else {
            select = selectQuery(resource, db.defaultsByTable, {});
        }
        for await (const chunk of connection.scan(chunkSize, select.sql, select.params)) {
            yield select.deserialize(chunk);
        }
    };
}

export class DatabaseTable<S, PK extends Key<S>, V extends Key<S>> implements Table<S, PK, V> {
    /**
     * List of indexes for this database table.
     */
    constructor(
        public readonly resource: Resource<S, PK, V>,
        public readonly indexes: string[][] = [],
    ) {}

    /**
     * Returns a state representation of the table for migration.
     */
    public getState(): TableState {
        const { indexes } = this;
        const { name } = this.resource;
        return getResourceState(name, this.resource, indexes);
    }
}
/***** DATABASE OPERATIONS *******/

/**
 * Returns a database operation that inserts an item with the given ID
 * to the database table. The item must contain all resource attributes,
 * including the identifying attributes and the version attribute.
 *
 * It results to an error if an item with the same identifying
 * attributes already exists in the database.
 *
 * Results to the given item object if inserted successfully.
 */
export function create<S>(
    resource: Resource<S, any, any>,
    item: S,
): SqlOperation<S> {
    const insertedValues = resource.validate(item);
    return async (connection, db) => {
        const query = insertQuery(resource, db.defaultsByTable, insertedValues);
        const aggregationQueries = db.getAggregationQueries(resource, insertedValues, null);
        const result = aggregationQueries.length
            ? await withTransaction(connection, async () => {
                const res = await executeQuery(connection, query);
                if (res) {
                    // Update aggregations
                    await executeAll(connection, db, aggregationQueries);
                }
                return res;
            })
            : await executeQuery(connection, query);
        if (!result) {
            throw new PreconditionFailed(`Item already exists.`);
        }
        return result.item;
    };
}

/**
 * Returns a database operation that either creates an item or
 * replaces an existing one. Use this if you don't care if the
 * item already existed in the database.
 *
 * Results to the given item object if written successfully.
 */
export function write<S, PK extends Key<S>, V extends Key<S>>(
    resource: Resource<S, PK, V>,
    item: S,
): SqlOperation<S> {
    return upsert(resource, item, item);
}

/**
 * Returns a database operation that inserts an item with the given ID
 * to the database table if it does not exist yet. If it already exists,
 * then returns null without failing.
 *
 * The given item must contain all resource attributes, including
 * the identifying attributes and the version attribute.
 */
export function initiate<S>(
    resource: Resource<S, any, any>,
    item: S,
): SqlOperation<S | null> {
    const insertedValues = resource.validate(item);
    return async (connection, db) => {
        const query = insertQuery(resource, db.defaultsByTable, insertedValues);
        const aggregationQueries = db.getAggregationQueries(resource, insertedValues, null);
        const result = aggregationQueries.length
            ? await withTransaction(connection, async () => {
                const res = await executeQuery(connection, query);
                if (res) {
                    // Update aggregations
                    await executeAll(connection, db, aggregationQueries);
                }
                return res;
            })
            : await executeQuery(connection, query);
        return result && result.item;
    };
}

/**
 * Returns a database operation that replaces an existing item in the
 * database table, identified by the given identity object. The given
 * item object must contain all model attributes, including the identifying
 * attributes and the new version attribute.
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
export function replace<S, PK extends Key<S>, V extends Key<S>>(
    resource: Resource<S, PK, V>,
    identity: Identity<S, PK, V>,
    item: S,
): SqlOperation<S> {
    // Perform an update, but require all the resource properties
    resource.validate(item);
    return update(resource, identity, item);
}

/**
 * Returns a database operation that updates some of the attributes
 * of an existing item in the database, identified by the given
 * identity object. The changes must contain the version attribute,
 * and any sub-set of the other attributes.
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
export function update<S, PK extends Key<S>, V extends Key<S>>(
    resource: Resource<S, PK, V>,
    identity: Identity<S, PK, V>,
    changes: PartialUpdate<S, V>,
): SqlOperation<S> {
    // TODO: Should be resource.partial(resource.versionBy)
    // Need to first support auto-versioning by aggregations, or remove versioning
    const updateSerializer = resource.fullPartial();
    const identitySerializer = resource
        .pick([...resource.identifyBy, ...resource.versionBy])
        .partial(resource.identifyBy);
    const filters = identitySerializer.validate(identity);
    const dynamicChanges = pickBy(changes, (_, value) => value instanceof Increment);
    const staticChanges = pickBy(changes, (_, value) => !(value instanceof Increment));
    const values = {
        ...dynamicChanges,
        ...updateSerializer.validate(staticChanges as PartialUpdate<S, V>),
    } as PartialUpdate<S, V>;
    return async (connection, db) => {
        const [result] = await withTransaction(connection, async () => {
            const query = updateQuery(resource, filters, values, db.defaultsByTable, true);
            const updates = await executeQuery(connection, query);
            for (const [newItem, oldItem] of updates) {
                // Row was actually updated
                // Update aggregations
                const aggregationQueries = db.getAggregationQueries(resource, newItem, oldItem);
                await executeAll(connection, db, aggregationQueries);
                return [newItem];
            }
            return [];
        });
        if (!result) {
            throw new NotFound(`Item was not found.`);
        }
        return result;
    };
}

/**
 * Returns a database operation that inserts a new item to the database
 * or updates an existing item if one already exists with the same identity.
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
export function upsert<S, PK extends Key<S>, V extends Key<S>>(
    resource: Resource<S, PK, V>,
    creation: S,
    changes: PartialUpdate<S, V>,
): SqlOperation<S> {
    const updateSerializer = resource.partial(resource.versionBy);
    const insertValues = resource.validate(creation);
    const updateValues = updateSerializer.validate(changes);
    return (connection, db) => withTransaction(connection, async () => {
        const aggregationQueries = db.getAggregationQueries(resource, insertValues, null);
        const query = insertQuery(resource, db.defaultsByTable, insertValues, updateValues);
        const res = await connection.query(query.sql, query.params);
        const insertion = query.deserialize(res);
        if (insertion.wasCreated) {
            // Row was actually inserted
            // Update aggregations
            await executeAll(connection, db, aggregationQueries);
        }
        return insertion.item;
    });
}

/**
 * Returns a database operation that deletes an item from the database,
 * identified by the given identity object. Fails if the item does not exists.
 */
export function destroy<S, PK extends Key<S>, V extends Key<S>>(
    resource: Resource<S, PK, V>,
    identity: Identity<S, PK, V>,
): SqlOperation<void> {
    const identitySerializer = resource
        .pick([...resource.identifyBy, ...resource.versionBy])
        .partial(resource.identifyBy);
    const filters = identitySerializer.validate(identity);
    return async (connection, db) => {
        const query = deleteQuery(resource, filters, db.defaultsByTable);
        const result = await withTransaction(connection, async () => {
            const item = await executeQuery(connection, query);
            if (item) {
                // Row was actually deleted
                // Update aggregations
                const aggregationQueries = db.getAggregationQueries(resource, null, item);
                await executeAll(connection, db, aggregationQueries);
            }
            return item;
        });
        if (!result) {
            throw new NotFound(`Item was not found.`);
        }
    };
}

/**
 * Returns an database operation for counting items in an table matching
 * the given filtering criterias. The criteria must match the indexes in the table.
 * Please consider the poor performance of COUNT operation on large tables!
 * Always prefer aggregations whenever appropriate instead of counting
 * large number of rows in the database.
 *
 * @param filters Filters defining which rows to count
 */
export function count<S>(
    resource: Resource<S, any, any>,
    filters: Filters<S>,
): SqlOperation<number> {
    return async (connection, db) => {
        const query = countQuery(resource, filters, db.defaultsByTable);
        return executeQuery(connection, query);
    };
}

/**
 * Returns a database operation for retrieving item for each of the identity given objects,
 * or null values if no matching item is found, in the most efficient way possible. The results
 * from the returned promise are in the same order than the identities.
 */
export function batchRetrieve<S, PK extends Key<S>, V extends Key<S>>(
    resource: Resource<S, PK, V>,
    identities: Array<Identity<S, PK, V>>,
): SqlOperation<Array<S | null>> {
    if (!identities.length) {
        return async () => [];
    }
    const identitySerializer = resource
        .pick([...resource.identifyBy, ...resource.versionBy])
        .partial(resource.identifyBy);
    const identityListSerializer = nestedList(identitySerializer);
    const filtersList = identityListSerializer.validate(identities);
    return async (connection, db) => {
        const query = batchSelectQuery(resource, db.defaultsByTable, filtersList);
        const items = await executeQuery(connection, query);
        return filtersList.map((identity) => (
            items.find((item) => item && hasProperties(item, identity)) || null
        ));
    };
}

interface TableOptions<S, PK extends Key<S>, V extends Key<S>> {
    /**
     * Sets default values for the properties loaded from the database.
     * They are used to fill in any missing values for loaded items. You should
     * provide this when you have added any new fields to the database
     * model. Otherwise you will get errors when attempting to decode an object
     * from the database that lack required attributes.
     */
    migrate?: { [P in Exclude<keyof S, PK | V>]?: S[P] };
    indexes?: Array<Array<Key<S>>>;
}

interface Aggregation<S> {
    target: Resource<any, any, any>;
    type: 'count' | 'sum';
    field: string;
    by: {[pk: string]: Key<S>};
    filters: Partial<S>;
}

class DatabaseDefinition implements Database {
    public readonly tables: Array<DatabaseTable<any, any, any>> = [];
    public defaultsByTable: TableDefaults = {};
    private aggregationsBySource: {[name: string]: Array<Aggregation<any>>} = {};

    public getAggregationQueries<S>(resource: Resource<S, any, any>, newValues: S | null, oldValues: S | null) {
        const idValues = newValues || oldValues;
        if (!idValues) {
            // Both parameters are null
            return [];
        }
        // NOTE: Sorting by aggregation table names to ensure a consistent
        // order that minimizes possibility for deadlocks.
        const resourceAggregations = this.aggregationsBySource[resource.name] || [];
        const aggregations = sort(resourceAggregations, (agg) => agg.target.name);
        return aggregations.map(({ target, by, field, filters }) => {
            const identifier = transformValues(by, (pk) => idValues[pk as keyof S]);
            const mask = { ...filters, ...identifier };
            const isMatching = newValues != null && hasProperties(newValues, mask);
            const wasMatching = oldValues != null && hasProperties(oldValues, mask);
            const diff = (isMatching ? 1 : 0) - (wasMatching ? 1 : 0);
            if (diff === 0) {
                return null;
            }
            return update(target, identifier, {[field]: increment(diff)});
        }).filter(isNotNully);
    }

    public addTable<S, PK extends Key<S>, V extends Key<S>>(resource: Resource<S, PK, V>, options?: TableOptions<S, PK, V>): this {
        this.tables.push(new DatabaseTable(resource, options && options.indexes || []));
        this.defaultsByTable[resource.name] = options && options.migrate || {};
        return this;
    }

    public aggregateCount<S, T, TPK extends Key<T>>(
        source: Resource<S, any, any>,
        target: Resource<T, TPK, any>,
        field: string & FilteredKeys<T, number>,
        by: {[P in TPK]: string & FilteredKeys<S, T[P]>},
        filters: Partial<S> = {},
    ): this {
        const aggregations = this.aggregationsBySource[source.name] || [];
        aggregations.push({ target, field, by, filters, type: 'count' });
        this.aggregationsBySource[source.name] = aggregations;
        return this;
    }
}

export function database(): DatabaseDefinition {
    return new DatabaseDefinition();
}

export function getResourceState(name: string, resource: Resource<any, Key<any>, Key<any>>, indexes: string[][]): TableState {
    const { fields, identifyBy } = resource;
    return {
        name,
        primaryKeys: identifyBy.map((key) => ({
            name: key,
            type: fields[key].type,
        })),
        columns: Object.keys(fields)
            .filter((key) => !identifyBy.includes(key))
            .map((key) => ({
                name: key,
                type: fields[key].type,
            })),
        // tslint:disable-next-line:no-shadowed-variable
        indexes: indexes.map((keys) => ({ keys })),
    };
}

async function executeAll(connection: SqlConnection, db: Database, operations: Array<SqlOperation<any>>) {
    for (const operation of operations) {
        await operation(connection, db);
    }
}
