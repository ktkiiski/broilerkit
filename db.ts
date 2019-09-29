import { ClientBase } from 'pg';
import { TableState } from './migration';
import { OrderedQuery, Page } from './pagination';
import { PostgreSqlDbModel } from './postgres';
import { Resource } from './resources';
import { Serializer } from './serializers';
import { Exact, Key, keys, Require } from './utils/objects';

export type Filters<T> = {[P in keyof T]?: T[P] | Array<T[P]>};
export type Query<T> = (OrderedQuery<T, Key<T>> & Filters<T>) | OrderedQuery<T, Key<T>>;
export type IndexQuery<T, Q extends keyof T, O extends keyof T> = {[P in Q]: T[P] | Array<T[P]>} & OrderedQuery<T, O> & Filters<T>;

export type Identity<S, PK extends Key<S>, V extends Key<S>> = (Pick<S, PK | V> | Pick<S, PK>) & Partial<S>;
export type PartialUpdate<S, V extends Key<S>> = Require<S, V>;

export interface Model<T, I, R, P, D> {
    /**
     * Serializer for the items returned by the database table.
     */
    readonly serializer: Serializer<T>;
    /**
     * Gets the item from the database using the given identity
     * object, containing all the identifying attributes.
     *
     * It results to an error if the item is not found.
     * Optionally the error object may be given as an attribute.
     *
     * Results to the item object, with all of its attributes,
     * if found successfully.
     */
    retrieve(identity: I): Promise<T>;
    /**
     * Inserts an item with the given ID to the database,
     * The given item must contain all model attributes, including
     * the identifying attributes and the version attribute.
     *
     * It results to an error if an item with the same identifying
     * attributes already exists in the database.
     *
     * Results to the given item object if inserted successfully.
     */
    create(item: R): Promise<T>;
    /**
     * Replaces an existing item in the database, identified by the given
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
    replace(identity: I, item: R): Promise<T>;
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
    update(identity: I, changes: P): Promise<T>;
    /**
     * Same than patch, but instead resulting to the whole updated object,
     * only results to the changes given as parameter. Prefer this instead
     * of patch if you do not need to know all the up-to-date attributes of the
     * object after a successful patch, as this is more efficient.
     */
    amend<C extends P>(identity: I, changes: C): Promise<C>;
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
    upsert(creation: T, update: P): Promise<T>;
    /**
     * Either creates an item or replaces an existing one.
     * Use this instead of create/put method if you don't care if the
     * item already existed in the database.
     *
     * Results to the given item object if written successfully.
     */
    write(item: T): Promise<T>;
    /**
     * Deletes an item from the database, identified by the given
     * identity object. Fails if the item does not exists.
     */
    destroy(identity: I): Promise<void>;
    /**
     * Deletes an item from the database if it exists in the database.
     * Unlike destroy, this does not fail if the item didn't exists.
     */
    clear(identity: I): Promise<void>;
    /**
     * Queries and finds the first/next batch of items from the table
     * matching the given criteria.
     *
     * The return value is a page object containing an array of items,
     * and the query parameters to retrieve the next batch, or null
     * if no more items are found.
     */
    list<Q extends D & OrderedQuery<T, Key<T>>>(query: Exact<Q, D>): Promise<Page<T, Q>>;
    /**
     * Iterate over batches of items from the table matching the given criteria.
     *
     * Without parameters should scan the whole table, in some order.
     */
    scan(query?: Query<T>): AsyncIterable<T[]>;
    /**
     * Retrieves item for each of the identity given objects, or null values if no
     * matching item is found, in the most efficient way possible. The results
     * from the returned promise are in the same order than the identities.
     */
    batchRetrieve(identities: I[]): Promise<Array<T | null>>;
}

export type VersionedModel<T, PK extends Key<T>, V extends Key<T>, D> = Model<T, Identity<T, PK, V>, T, PartialUpdate<T, V>, D>;

export interface TableOptions<T, PK extends Key<T>, V extends Key<T>, D extends Exclude<keyof T, PK | V>> {
    /**
     * An identifying name for the table that distinguishes it from the
     * other table definitions.
     */
    name: string;
    /**
     * Optional default values for the properties loaded from the database.
     * They used to fill in any missing values for loaded items. You should
     * provide this option when you have added any new fields to the database
     * model. Otherwise you will get errors when attempting to decode an object
     * from the database that lack required attributes.
     */
    defaults?: {[P in D]: T[P]};
}

export interface ModelContext {
    region: string;
    environment: {[key: string]: string};
    /**
     * Returns a promise for an open PostgreSQL database connection.
     * It always uses an existing connection if already opened for
     * this request, or uses one from a collection pool if available.
     * Note that the connection will be shared with other models during
     * a request execution.
     */
    connect(): Promise<ClientBase>;
}

export interface Table<M> {
    /**
     * An identifying name for the table that distinguishes it from the
     * other table definitions.
     */
    name: string;
    /**
     * A definition of the resource being stored to this database table.
     */
    resource: Resource<any, any, any>;
    /**
     * List of indexes for this database table.
     */
    indexes: string[][];
    /**
     * Binds the table to a execution contect, returning an actual model
     * that is used to read and write data from/to the database.
     */
    getModel(context: ModelContext): M;
    /**
     * Returns a state representation of the table for migration.
     */
    getState(): TableState;
}

type IndexTree<T> = {[P in keyof T]?: IndexTree<T>};

export class TableDefinition<S, PK extends Key<S>, V extends Key<S>, D> implements Table<VersionedModel<S, PK, V, D>> {

    public readonly indexes: string[][] = [];
    constructor(
        public readonly resource: Resource<S, PK, V>,
        public readonly name: string,
        private readonly indexTree: IndexTree<S>,
        private readonly defaults?: {[P in any]: S[any]},
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
        return new TableDefinition(this.resource, this.name, this.indexTree, {...this.defaults, ...defaults});
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
        return new TableDefinition(this.resource, this.name, {...this.indexTree, ...newIndexes}, this.defaults);
    }

    public getModel(context: ModelContext): VersionedModel<S, PK, V, D> {
        return new PostgreSqlDbModel(context, this.name, this.resource);
    }

    public getState(): TableState {
        const { name, indexes } = this;
        return getResourceState(name, this.resource, indexes);
    }
}

/**
 * @param resource Resource that is stored to the table
 * @param name An unique name for the table
 */
export function table<S, PK extends Key<S>, V extends Key<S>>(resource: Resource<S, PK, V>, name: string) {
    return new TableDefinition<S, PK, V, never>(resource, name, {});
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
