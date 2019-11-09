import { TableState } from './migration';
import { OrderedQuery } from './pagination';
import { executeQueries, executeQuery, SqlOperation, withTransaction } from './postgres';
import { Resource } from './resources';
import { countQuery, increment, insertQuery, SqlQuery, updateQuery } from './sql';
import { sort } from './utils/arrays';
import { hasProperties, isNotNully } from './utils/compare';
import { FilteredKeys, Key, keys, Require, transformValues } from './utils/objects';

export type Filters<T> = {[P in keyof T]?: T[P] | Array<T[P]>};
export type Query<T> = (OrderedQuery<T, Key<T>> & Filters<T>) | OrderedQuery<T, Key<T>>;
export type IndexQuery<T, Q extends keyof T, O extends keyof T> = {[P in Q]: T[P] | Array<T[P]>} & OrderedQuery<T, O> & Filters<T>;

export type Identity<S, PK extends Key<S>, V extends Key<S>> = (Pick<S, PK | V> | Pick<S, PK>) & Partial<S>;
export type PartialUpdate<S, V extends Key<S>> = Require<S, V>;

export type Table = TableDefinition<any, Key<any>, Key<any>, any>;

type IndexTree<T> = {[P in keyof T]?: IndexTree<T>};

interface Aggregation<S> {
    target: Table;
    type: 'count' | 'sum';
    field: string;
    by: {[pk: string]: Key<S>};
    filters: Partial<S>;
}

export class TableDefinition<S, PK extends Key<S>, V extends Key<S>, D> implements Table {

    /**
     * List of indexes for this database table.
     */
    public readonly indexes: string[][] = [];
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
        private readonly indexTree: IndexTree<S>,
        public readonly defaults: {[P in any]: S[any]},
        public readonly aggregations: Array<Aggregation<S>>,
    ) {
        this.indexes = flattenIndexes(indexTree);
    }

    /**
     * Sets default values for the properties loaded from the database.
     * They are used to fill in any missing values for loaded items. You should
     * provide this when you have added any new fields to the database
     * model. Otherwise you will get errors when attempting to decode an object
     * from the database that lack required attributes.
     */
    public migrate<K extends Exclude<keyof S, PK | V>>(defaults: {[P in K]: S[P]}): TableDefinition<S, PK, V, D> {
        return new TableDefinition(this.resource, this.name, this.indexTree, {...this.defaults, ...defaults}, this.aggregations);
    }

    public index<K1 extends keyof S>(key: K1): TableDefinition<S, PK, V, D | IndexQuery<S, never, K1>>;
    public index<K1 extends keyof S, K2 extends keyof S>(key1: K1, key2: K2): TableDefinition<S, PK, V, D | IndexQuery<S, K1, K2>>;
    public index<K1 extends keyof S, K2 extends keyof S, K3 extends keyof S>(key1: K1, key2: K2, key3: K3): TableDefinition<S, PK, V, D | IndexQuery<S, K1 | K2, K3>>;
    public index<K extends keyof S>(...index: K[]): TableDefinition<S, PK, V, D | IndexQuery<S, K, K>> {
        let newIndexes: IndexTree<S> = {};
        while (index.length) {
            const key = index.pop() as K;
            newIndexes = {[key]: newIndexes} as IndexTree<S>;
        }
        return new TableDefinition(this.resource, this.name, {...this.indexTree, ...newIndexes}, this.defaults, this.aggregations);
    }

    public aggregate<T, TPK extends Key<T>>(target: TableDefinition<T, TPK, any, any>) {
        const count = (
            countField: string & FilteredKeys<T, number>,
            by: {[P in TPK]: string & FilteredKeys<S, T[P]>},
            filters: Partial<S> = {},
        ) => {
            const aggregations = this.aggregations.concat([{
                target, type: 'count', field: countField, by, filters,
            }]);
            return new TableDefinition<S, PK, V, D>(this.resource, this.name, this.indexTree, this.defaults, aggregations);
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
     * Returns an database operation for counting items in an table matching
     * the given filtering criterias. The criteria must match the indexes in the table.
     * Please consider the poor performance of COUNT operation on large tables!
     * Always prefer aggregations whenever appropriate instead of counting
     * large number of rows in the database.
     *
     * @param filters Filters defining which rows to count
     */
    public count(
        filters: Omit<D, 'direction' | 'ordering' | 'since'>,
    ): SqlQuery<number> {
        return countQuery(this, filters);
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
export function table<S, PK extends Key<S>, V extends Key<S>>(resource: Resource<S, PK, V>, name: string) {
    return new TableDefinition<S, PK, V, never>(resource, name, {}, {}, []);
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
