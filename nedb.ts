import * as Datastore from 'nedb';
import { Identity, PartialUpdate, Query, TableOptions, VersionedModel } from './db';
import { NotFound } from './http';
import { Page, prepareForCursor } from './pagination';
import { Resource, SerializedResource, Serializer } from './resources';
import { buildQuery } from './url';
import { mapCached } from './utils/arrays';
import { forEachKey, Key, omit, pick, spread } from './utils/objects';

const PRIMARY_KEY_FIELD = '_pk';

export class NeDbModel<S, PK extends Key<S>, V extends Key<S>> implements VersionedModel<S, PK, V, Query<S>> {

    private updateSerializer = this.resource.partial([this.options.versionBy]);
    private identitySerializer = this.resource.partial(this.options.identifyBy);
    private primaryKeySerializer = this.resource.pick(this.options.identifyBy);
    private readonly decoder: Serializer<any, S>;
    private db = getDb(this.filePath);

    constructor(private filePath: string, private resource: Resource<S>, private options: TableOptions<S, PK, V>) {
        this.decoder = options.defaults ?
            // Decode by migrating the defaults
            this.resource.optional({
                required: [...options.identifyBy, options.versionBy],
                optional: [],
                defaults: options.defaults,
            }) as Serializer<any, S> :
            // Otherwise migrate with a possibility that there are missing properties
            this.resource
        ;
        // Ensure uniqueness for the primary key (in addition to the built-in `_id` field)
        this.db.ensureIndex({
            fieldName: PRIMARY_KEY_FIELD,
            unique: true,
        });
    }

    public async retrieve(identity: Identity<S, PK, V>, notFoundError?: Error) {
        const query = this.getItemQuery(identity);
        const serializedItem = await this.findItem(query);
        if (!serializedItem) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return this.decoder.deserialize(serializedItem);
    }

    public async create(item: S, alreadyExistsError?: Error) {
        const serializedItem = {
            ...this.resource.serialize(item),
            [PRIMARY_KEY_FIELD]: this.getItemPrimaryKey(item),
        };
        try {
            await this.insertItem(serializedItem);
        } catch (error) {
            throw (error.errorType === 'uniqueViolated' && alreadyExistsError) || error;
        }
        return item;
    }

    public async replace(identity: Identity<S, PK, V>, item: S, notFoundError?: Error) {
        const {resource} = this;
        const query = this.getItemQuery(identity);
        const serializedItem = {
            ...resource.serialize(item),
            [PRIMARY_KEY_FIELD]: this.getItemPrimaryKey(identity),
        };
        const updatedSerializedItem = await this.updateItem(query, serializedItem);
        if (!updatedSerializedItem) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return this.decoder.deserialize(updatedSerializedItem);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>, notFoundError?: Error): Promise<S> {
        const query = this.getItemQuery(identity);
        const serializedChanges = this.updateSerializer.serialize(changes);
        const updatedSerializedItem = await this.updateItem(query, {$set: serializedChanges});
        if (!updatedSerializedItem) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return this.decoder.deserialize(updatedSerializedItem);
    }

    public async amend<C extends PartialUpdate<S, V>>(identity: Identity<S, PK, V>, changes: C, notFoundError?: Error): Promise<C> {
        // TODO: Better performing implementation
        await this.update(identity, changes, notFoundError);
        return changes;
    }

    public async write(item: S): Promise<S> {
        const alreadyExistsError = new Error(`Item already exists!`);
        try {
            return await this.create(item, alreadyExistsError);
        } catch (error) {
            if (error !== alreadyExistsError) {
                throw error;
            }
            return await this.replace(
                pick(item, this.options.identifyBy) as Identity<S, PK, V>,
                item,
            );
        }
    }

    public async destroy(identity: Identity<S, PK, V>, notFoundError?: Error) {
        const query = this.getItemQuery(identity);
        const removedCount = await this.removeItem(query);
        if (!removedCount) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        const query = this.getItemQuery(identity);
        await this.removeItem(query);
    }

    public async list<Q extends Query<S>>(query: Q): Promise<Page<S, Q>> {
        const { decoder } = this;
        const { fields } = this.resource;
        const { ordering, direction, since } = query;
        const filterAttrs = omit(query as {[key: string]: any}, ['ordering', 'direction', 'since']) as Partial<S>;
        const filter: {[key: string]: any} = {};
        forEachKey(filterAttrs, (key: any, value: any) => {
            const field = (fields as any)[key];
            filter[key] = field.serialize(value);
        });
        if (since !== undefined) {
            const field = fields[ordering];
            filter[ordering] = {
                [direction === 'asc' ? '$gt' : '$lt']: field.serialize(since),
            };
        }
        for (let maxCount = 10; ; maxCount += 10) {
            const serializedItems = await this.findItems(filter, ordering, direction, maxCount);
            const results = serializedItems.map((serializedItem) => decoder.deserialize(serializedItem));
            if (results.length < maxCount) {
                return {results, next: null};
            }
            const cursor = prepareForCursor(results, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: spread(query, {since: cursor.since}),
                };
            }
        }
    }
    public batchRetrieve(identities: Array<Identity<S, PK, V>>) {
        const notFoundError = new Error(`Not found`);
        const promises = mapCached(identities, (identity) => (
            this.retrieve(identity, notFoundError).catch((error) => {
                if (error === notFoundError) {
                    return null;
                }
                throw error;
            })
        ));
        return Promise.all(promises);
    }

    private findItem(query: {[key: string]: any}) {
        return new Promise<SerializedResource | null>((resolve, reject) => {
            this.db.findOne(query, promiseCallback(resolve, reject));
        });
    }
    private findItems(query: {[key: string]: any}, ordering: string, direction: 'asc' | 'desc', maxCount: number) {
        return new Promise<SerializedResource[]>((resolve, reject) => {
            this.db.find(query)
                .sort({[ordering]: direction === 'asc' ? 1 : -1})
                .limit(maxCount)
                .exec(promiseCallback(resolve, reject))
            ;
        });
    }
    private insertItem(item: {[key: string]: any}) {
        return new Promise((resolve, reject) => {
            this.db.insert(item, promiseCallback(resolve, reject));
        });
    }
    private updateItem(query: {[key: string]: any}, update: {[key: string]: any}) {
        const options = {multi: false, returnUpdatedDocs: true};
        return new Promise<SerializedResource | null>((resolve, reject) => {
            this.db.update(query, update, options, (error, numAffected: number, updatedItem: any) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(numAffected && updatedItem ? updatedItem : null);
                }
            });
        });
    }
    private removeItem(query: {[key: string]: any}) {
        return new Promise<number>((resolve, reject) => {
            this.db.remove(query, promiseCallback(resolve, reject));
        });
    }
    private getItemQuery(identity: Identity<S, PK, V>): {[key: string]: any} {
        const serializedIdentity = this.identitySerializer.serialize(identity);
        return {
            ...serializedIdentity,
            [PRIMARY_KEY_FIELD]: this.getItemPrimaryKey(identity),
        };
    }
    private getItemPrimaryKey(identity: Identity<S, PK, V>): string {
        const encodedIdentity = this.primaryKeySerializer.encode(identity);
        return buildQuery(encodedIdentity);
    }
}

function promiseCallback<T>(resolve: (result: T) => void, reject: (error: any) => void) {
    return (error: any, result: T) => {
        if (error != null) {
            reject(error);
        } else {
            resolve(result);
        }
    };
}

/*
 * Need this internal caching mechanism to avoid issues with the same NeDB database
 * file being opened multiple times.
 */

const dbCache: {[filePath: string]: Datastore} = {};

function getDb(filePath: string): Datastore {
    let db = dbCache[filePath];
    if (db) {
        return db;
    }
    db = dbCache[filePath] = new Datastore({filename: filePath});
    db.loadDatabase((error) => {
        if (error && dbCache[filePath] === db) {
            delete dbCache[filePath];
        }
    });
    return db;
}
