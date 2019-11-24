import { nullable } from './fields';
import { NotFound, PreconditionFailed } from './http';
import { TableState } from './migration';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { executeQueries, executeQuery, SqlOperation, withTransaction } from './postgres';
import { Resource } from './resources';
import { Fields, nested, nestedList } from './serializers';
import { batchSelectQuery, countQuery, deleteQuery, increment, insertQuery, selectQuery, SqlQuery, SqlScanQuery, SqlWriteable, updateQuery } from './sql';
import { SqlNesting, SqlQueryable } from './sql';
import { sort } from './utils/arrays';
import { hasProperties, isNotNully } from './utils/compare';
import { Exact, FilteredKeys, Key, keys, pick, Require, transformValues } from './utils/objects';

export type Filters<T> = {[P in keyof T]?: T[P] | Array<T[P]>};
export type Query<T> = (OrderedQuery<T, Key<T>> & Filters<T>) | OrderedQuery<T, Key<T>>;
export type IndexQuery<T, Q extends keyof T, O extends keyof T> = {[P in Q]: T[P] | Array<T[P]>} & OrderedQuery<T, O> & Filters<T>;

export type Identity<S, PK extends Key<S>, V extends Key<S> | undefined> = (Pick<S, PK | (V extends undefined ? never : V)> | Pick<S, PK>) & Partial<S>;
export type PartialUpdate<S, V extends Key<S>> = Require<S, V>;

type IndexTree<T> = {[P in keyof T]?: IndexTree<T>};

export interface ReadableModel<S, PK extends Key<S>, V extends Key<S> | undefined, D> {
    retrieve(query: Identity<S, PK, V>): SqlQuery<S>;
    list<Q extends D & OrderedQuery<S, Key<S>>>(query: Exact<Q, D>): SqlOperation<Page<S, Q>>;
    scan(query?: Query<S>): SqlScanQuery<S>;
    pick<K extends Key<S>>(columns: K[]): ReadableTable<Pick<S, K>, PK & K, V extends K ? K : undefined, Exclude<D, Record<Exclude<Key<K>, K>, any>>>;
    join<K extends string, S2, PK2 extends Key<S2>>(propertyName: K, table: SqlQueryable<S2, PK2 & Key<S2>>, on: {[P in PK2 & Key<S2>]: string & FilteredKeys<S, S2[P]>}): ReadableTable<S & Record<K, S2 | null>, PK, V, D>;
}

type ReadableTable<S, PK extends Key<S>, V extends Key<S> | undefined, D> = ReadableModel<S, PK, V, D> & SqlQueryable<S, PK>;

export interface Model<S, PK extends Key<S>, V extends Key<S>, D> extends ReadableModel<S, PK, V, D> {
    create(item: S): SqlOperation<S>;
    write(item: S): SqlOperation<S>;
    initiate(item: S): SqlOperation<S | null>;
    replace(identity: Identity<S, PK, V>, item: S): SqlOperation<S>;
    update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>): SqlOperation<S>;
    upsert(creation: S, update: PartialUpdate<S, V>): SqlOperation<S>;
    destroy(identity: Identity<S, PK, V>): SqlOperation<void>;
    count(filters: Omit<D, 'direction' | 'ordering' | 'since'>): SqlQuery<number>;
    batchRetrieve(identities: Array<Identity<S, PK, V>>): SqlQuery<Array<S | null>>;
}

export interface Table<S, PK extends Key<S>, V extends Key<S>, D>
extends Model<S, PK, V, D>, SqlWriteable<S, PK>, SqlQueryable<S, PK> {
    /**
     * Sets default values for the properties loaded from the database.
     * They are used to fill in any missing values for loaded items. You should
     * provide this when you have added any new fields to the database
     * model. Otherwise you will get errors when attempting to decode an object
     * from the database that lack required attributes.
     */
    migrate<K extends Exclude<keyof S, PK | V>>(defaults: {[P in K]: S[P]}): Table<S, PK, V, D>;

    index<K1 extends keyof S>(key: K1): Table<S, PK, V, D | IndexQuery<S, never, K1>>;
    index<K1 extends keyof S, K2 extends keyof S>(key1: K1, key2: K2): Table<S, PK, V, D | IndexQuery<S, K1, K2>>;
    index<K1 extends keyof S, K2 extends keyof S, K3 extends keyof S>(key1: K1, key2: K2, key3: K3): Table<S, PK, V, D | IndexQuery<S, K1 | K2, K3>>;
    index<K extends keyof S>(...index: K[]): Table<S, PK, V, D | IndexQuery<S, K, K>>;

    aggregate<T, TPK extends Key<T>>(target: Table<T, TPK, any, any>): Aggregator<S, PK, V, D, T, TPK>;

    getState(): TableState;
}

interface Aggregator<S, PK extends Key<S>, V extends Key<S>, D, T, TPK extends Key<T>> {
    count(
        countField: string & FilteredKeys<T, number>,
        by: {[P in TPK]: string & FilteredKeys<S, T[P]>},
        filters?: Partial<S>,
    ): Table<S, PK, V, D>;
}

interface Aggregation<S> {
    target: Table<any, any, any, any>;
    type: 'count' | 'sum';
    field: string;
    by: {[pk: string]: Key<S>};
    filters: Partial<S>;
}

class BaseTable<S, PK extends Key<S>, V extends Key<S> | undefined, D>
implements ReadableModel<S, PK, V, D>, SqlQueryable<S, PK> {

    constructor(
        /**
         * A definition of the resource being stored to this database table.
         */
        public readonly resource: Resource<S, PK, V>,
        /**
         * An identifying name for the table that distinguishes it from the
         * other table definitions.
         */
        public readonly name: string,
        public readonly columns: Fields<any>,
        public readonly primaryKeys: PK[],
        public readonly defaults: {[P in any]: any},
        public readonly nestings: SqlNesting[],
    ) {}

    /***** DATABASE OPERATIONS *******/

    /**
     * Returns a database operation that gets an item from the
     * database table using the given identity object, containing
     * all the identifying attributes.
     * It results to an error if the item was not found.
     */
    public retrieve(query: Identity<S, PK, V>): SqlQuery<S> {
        const { resource } = this;
        const { identifyBy, versionBy } = resource;
        const identitySerializer = versionBy
            ? resource
                .pick([...identifyBy, versionBy as Key<S>])
                .partial(identifyBy)
            : resource
                .pick(identifyBy);
        const filters = identitySerializer.validate(query);
        const select = selectQuery(this, filters, 1);
        return {
            ...select,
            deserialize: (result) => {
                const [item] = select.deserialize(result);
                if (!item) {
                    throw new NotFound(`Item was not found.`);
                }
                return item;
            },
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
    public list<Q extends D & OrderedQuery<S, Key<S>>>(query: Exact<Q, D>): SqlOperation<Page<S, Q>> {
        const results: S[] = [];
        const { ordering, direction } = query;
        const { chunkSize, sql, params, deserialize } = this.scan(query);
        return async (connection) => {
            for await (const chunk of connection.scan(chunkSize, sql, params)) {
                const items = deserialize(chunk);
                results.push(...items);
                if (chunk.isComplete) {
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
        };
    }

    /**
     * Returns a database scan query for iterating over batches of items from the
     * table matching the given criteria.
     *
     * Without parameters should scan the whole table, in no particular order.
     */
    public scan(query?: Query<S>): SqlScanQuery<S> {
        const chunkSize = 100;
        if (!query) {
            return {
                ...selectQuery(this, {}),
                chunkSize,
            };
        }
        const { ordering, direction, since, ...filters } = query;
        return {
            ...selectQuery(this, filters, undefined, ordering, direction, since),
            chunkSize,
        };
    }

    // NOTE: The signature does not completely match the interface because of this:
    // https://github.com/microsoft/TypeScript/issues/30071
    public join<K extends string, S2>(
        propertyName: K,
        other: SqlQueryable<S2>,
        on: {[key: string]: string},
    ): ReadableTable<S & Record<K, S2 | null>, PK, V, D> {
        const nestings: SqlNesting[] = [
            ...this.nestings,
            {
                alias: propertyName,
                queryable: other,
                on,
            },
        ];
        const resource: Resource<S & Record<K, S2 | null>, PK, V> = this.resource.expand(
            { [propertyName]: nullable(nested(other.resource)) } as Fields<Record<K, S2 | null>>,
        );
        return new BaseTable(
            resource, this.name, this.columns, this.primaryKeys, this.defaults, nestings,
        );
    }

    public pick<K extends Key<S>>(columns: K[]): ReadableTable<Pick<S, K>, PK & K, V extends K ? V : undefined, Exclude<D, Record<Exclude<Key<K>, K>, any>>> {
        const resource = this.resource.subset(columns);
        return new BaseTable<Pick<S, K>, PK & K, V extends K ? V : undefined, Exclude<D, Record<Exclude<Key<K>, K>, any>>>(
            resource,
            this.name,
            pick(this.columns, columns),
            this.primaryKeys as Array<PK & K>,
            pick(this.defaults, columns),
            this.nestings,
        );
    }

}

export class DatabaseTable<S, PK extends Key<S>, V extends Key<S>, D>
extends BaseTable<S, PK, V, D> implements Table<S, PK, V, D> {
    /**
     * List of indexes for this database table.
     */
    public readonly indexes: string[][] = [];
    constructor(
        resource: Resource<S, PK, V>,
        name: string,
        private readonly indexTree: IndexTree<S>,
        defaults: {[P in any]: S[any]},
        private readonly aggregations: Array<Aggregation<S>>,
    ) {
        super(resource, name, resource.fields, resource.identifyBy, defaults, []);
        this.indexes = flattenIndexes(indexTree);
    }

    /**
     * Sets default values for the properties loaded from the database.
     * They are used to fill in any missing values for loaded items. You should
     * provide this when you have added any new fields to the database
     * model. Otherwise you will get errors when attempting to decode an object
     * from the database that lack required attributes.
     */
    public migrate<K extends Exclude<keyof S, PK | V>>(defaults: {[P in K]: S[P]}): Table<S, PK, V, D> {
        return new DatabaseTable(this.resource, this.name, this.indexTree, {...this.defaults, ...defaults}, this.aggregations);
    }

    public index<K extends keyof S>(...index: K[]): Table<S, PK, V, D | IndexQuery<S, K, K>> {
        let newIndexes: IndexTree<S> = {};
        while (index.length) {
            const key = index.pop() as K;
            newIndexes = {[key]: newIndexes} as IndexTree<S>;
        }
        return new DatabaseTable(this.resource, this.name, {...this.indexTree, ...newIndexes}, this.defaults, this.aggregations);
    }

    // NOTE: The signature does not completely match the interface because of this:
    // https://github.com/microsoft/TypeScript/issues/30071
    public aggregate<T>(target: Table<T, any, any, any>) {
        const count = (
            countField: string & FilteredKeys<T, number>,
            by: {[key: string]: Key<S>},
            filters: Partial<S> = {},
        ): Table<S, PK, V, D> => {
            const aggregations = this.aggregations.concat([{
                target, type: 'count', field: countField, by, filters,
            }]);
            return new DatabaseTable<S, PK, V, D>(this.resource, this.name, this.indexTree, this.defaults, aggregations);
        };
        return { count };
    }

    /**
     * Returns a state representation of the table for migration.
     */
    public getState(): TableState {
        const { name, indexes } = this;
        return getResourceState(name, this.resource, indexes);
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
    public create(item: S): SqlOperation<S> {
        const insertedValues = this.resource.validate(item);
        const query = insertQuery(this, insertedValues);
        const aggregationQueries = this.getAggregationQueries(insertedValues, null);
        return async (connection) => {
            const result = aggregationQueries.length
                ? await withTransaction(connection, async () => {
                    const res = await executeQuery(connection, query);
                    if (res) {
                        // Update aggregations
                        await executeQueries(connection, aggregationQueries);
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
    public write(item: S): SqlOperation<S> {
        return this.upsert(item, item);
    }

    /**
     * Returns a database operation that inserts an item with the given ID
     * to the database table if it does not exist yet. If it already exists,
     * then returns null without failing.
     *
     * The given item must contain all resource attributes, including
     * the identifying attributes and the version attribute.
     */
    public initiate(item: S): SqlOperation<S | null> {
        const insertedValues = this.resource.validate(item);
        const query = insertQuery(this, insertedValues);
        const aggregationQueries = this.getAggregationQueries(insertedValues, null);
        return async (connection) => {
            const result = aggregationQueries.length
                ? await withTransaction(connection, async () => {
                    const res = await executeQuery(connection, query);
                    if (res) {
                        // Update aggregations
                        await executeQueries(connection, aggregationQueries);
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
    public replace(identity: Identity<S, PK, V>, item: S): SqlOperation<S> {
        // Perform an update, but require all the resource properties
        const { resource } = this;
        resource.validate(item);
        return this.update(identity, item);
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
    public update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>): SqlOperation<S> {
        const { resource } = this;
        const updateSerializer = resource.partial([resource.versionBy]);
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const filters = identitySerializer.validate(identity);
        const values = updateSerializer.validate(changes);
        return async (connection) => {
            const [result] = this.aggregate.length
                ? await withTransaction(connection, async () => {
                    const query = updateQuery(this, filters, values, true);
                    const updates = await executeQuery(connection, query);
                    for (const [newItem, oldItem] of updates) {
                        // Row was actually updated
                        // Update aggregations
                        const aggregationQueries = this.getAggregationQueries(newItem, oldItem);
                        await executeQueries(connection, aggregationQueries);
                        return [newItem];
                    }
                    return [];
                })
                : await executeQuery(
                    connection,
                    updateQuery(this, filters, values, false),
                );
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
    public upsert(creation: S, update: PartialUpdate<S, V>): SqlOperation<S> {
        const { resource } = this;
        const updateSerializer = resource.partial([resource.versionBy]);
        const insertValues = resource.validate(creation);
        const updateValues = updateSerializer.validate(update);
        const aggregationQueries = this.getAggregationQueries(insertValues, null);
        const query = insertQuery(this, insertValues, updateValues);
        if (!aggregationQueries.length) {
            return async (connection) => {
                const insertion = await executeQuery(connection, query);
                return insertion.item;
            };
        }
        return (connection) => withTransaction(connection, async () => {
            const res = await connection.query(query.sql, query.params);
            const insertion = query.deserialize(res);
            if (insertion.wasCreated) {
                // Row was actually inserted
                // Update aggregations
                await executeQueries(connection, aggregationQueries);
            }
            return insertion.item;
        });
    }

    /**
     * Returns a database operation that deletes an item from the database,
     * identified by the given identity object. Fails if the item does not exists.
     */
    public destroy(identity: Identity<S, PK, V>): SqlOperation<void> {
        const { resource } = this;
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const filters = identitySerializer.validate(identity);
        const query = deleteQuery(this, filters);
        return async (connection) => {
            const result = this.aggregations.length
                ? await withTransaction(connection, async () => {
                    const item = await executeQuery(connection, query);
                    if (item) {
                        // Row was actually deleted
                        // Update aggregations
                        const aggregationQueries = this.getAggregationQueries(null, item);
                        await executeQueries(connection, aggregationQueries);
                    }
                    return item;
                })
                : await executeQuery(connection, query);
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
    public count(filters: Omit<D, 'direction' | 'ordering' | 'since'>): SqlQuery<number> {
        return countQuery(this, filters);
    }

    /**
     * Returns a database operation for retrieving item for each of the identity given objects,
     * or null values if no matching item is found, in the most efficient way possible. The results
     * from the returned promise are in the same order than the identities.
     */
    public batchRetrieve(identities: Array<Identity<S, PK, V>>): SqlQuery<Array<S | null>> {
        if (!identities.length) {
            return { sql: '', params: [], deserialize: () => [] };
        }
        const { resource } = this;
        const identitySerializer = resource
            .pick([...resource.identifyBy, resource.versionBy])
            .partial(resource.identifyBy);
        const identityListSerializer = nestedList(identitySerializer);
        const filtersList = identityListSerializer.validate(identities);
        const query = batchSelectQuery(this, filtersList);
        return {
            ...query,
            deserialize: (result) => {
                const items = query.deserialize(result);
                return filtersList.map((identity) => (
                    items.find((item) => item && hasProperties(item, identity)) || null
                ));
            },
        };
    }

    private getAggregationQueries(newValues: S | null, oldValues: S | null) {
        const idValues = newValues || oldValues;
        if (!idValues) {
            // Both parameters are null
            return [];
        }
        // NOTE: Sorting by aggregation table names to ensure a consistent
        // order that minimizes possibility for deadlocks.
        const aggregations = sort(this.aggregations, (agg) => agg.target.name);
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

/**
 * @param resource Resource that is stored to the table
 * @param name An unique name for the table
 */
export function table<S, PK extends Key<S>, V extends Key<S>>(resource: Resource<S, PK, V>, name: string): Table<S, PK, V, never> {
    return new DatabaseTable<S, PK, V, never>(resource, name, {}, {}, []);
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

function flattenIndexes<S>(idxTree: IndexTree<S>): Array<Array<Key<S>>> {
    const indexes: Array<Array<Key<S>>> = [];
    keys(idxTree).forEach((key) => {
        const subIndexes = flattenIndexes(idxTree[key] as IndexTree<S>);
        if (subIndexes.length) {
            indexes.push([key]);
        } else {
            indexes.push(...subIndexes.map((subIndex) => [key, ...subIndex]));
        }
    });
    return indexes;
}
