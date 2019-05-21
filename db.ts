import { parseARN } from './aws/arn';
import { NeDbModel } from './nedb';
import { OrderedQuery, Page } from './pagination';
import { Resource } from './resources';
import { Serializer } from './serializers';
import { SimpleDbModel } from './simpledb';
import { Key, Require } from './utils/objects';

export type Filters<T> = {[P in keyof T]: T | T[]};
export type Query<T> = OrderedQuery<T, Key<T>> & Partial<Filters<T>> | OrderedQuery<T, Key<T>>;

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
    retrieve(identity: I, notFoundError?: Error): Promise<T>;
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
    create(item: R, alreadyExistsError?: Error): Promise<T>;
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
    replace(identity: I, item: R, notFoundError?: Error): Promise<T>;
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
    update(identity: I, changes: P, notFoundError?: Error): Promise<T>;
    /**
     * Same than patch, but instead resulting to the whole updated object,
     * only results to the changes given as parameter. Prefer this instead
     * of patch if you do not need to know all the up-to-date attributes of the
     * object after a successful patch, as this is more efficient.
     */
    amend<C extends P>(identity: I, changes: C, notFoundError?: Error): Promise<C>;
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
    destroy(identity: I, notFoundError?: Error): Promise<void>;
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
    list<Q extends D>(query: Q): Promise<Page<T, Q>>;
    /**
     * Iterate over batches of items from the table matching the given criteria.
     *
     * Without parameters should scan the whole table, in some order.
     */
    scan(query?: D): AsyncIterable<T[]>;
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

export interface Table<M> {
    /**
     * An identifying name for the table that distinguishes it from the
     * other table definitions.
     */
    name: string;
    /**
     * Binds the table to a specific environment (stage), defining the
     * location where the table data is to be stored with the given URI.
     *
     * For a deployed environment, the URI should be an ARN of a SimpleDB
     * domain, for example:
     *
     *      arn:aws:sdb:us-east-1:111122223333:domain/Domain1
     *
     * For local environment, this describes the location of the SQLite3
     * database file where the data is to be persisted, for example:
     *
     *      file:/home/fred/data.db
     *
     * @param uri URI to the resource storing the data
     */
    getModel(uri: string): M;
}

export class TableDefinition<S, PK extends Key<S>, V extends Key<S>, D extends Exclude<keyof S, PK | V>> implements Table<VersionedModel<S, PK, V, Query<S>>> {

    public readonly name: string;
    constructor(public readonly resource: Resource<S, PK, V>, public readonly options: TableOptions<S, PK, V, D>) {
        this.name = options.name;
    }

    public getModel(uri: string): VersionedModel<S, PK, V, Query<S>> {
        const {resource, options} = this;
        if (uri.startsWith('arn:')) {
            const {service, region, resourceType, resourceId} = parseARN(uri);
            if (service !== 'sdb') {
                throw new Error(`Unknown AWS service "${service}"`);
            }
            if (resourceType !== 'domain') {
                throw new Error(`Unknown AWS resource type "${resourceType}"`);
            }
            return new SimpleDbModel<S, PK, V>(resourceId, region, resource, options.defaults);
        }
        if (uri.startsWith('file://')) {
            const filePath = uri.slice('file://'.length);
            return new NeDbModel(filePath, resource, options.defaults);
        }
        throw new Error(`Invalid database table URI ${uri}`);
    }
}

export function table<S, PK extends Key<S>, V extends Key<S>, D extends Exclude<keyof S, PK | V>>(resource: Resource<S, PK, V>, options: TableOptions<S, PK, V, D>) {
    return new TableDefinition(resource, options);
}
