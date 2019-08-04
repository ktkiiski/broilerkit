import * as Datastore from 'nedb';
import { Identity, PartialUpdate, Query, VersionedModel } from './db';
import { HttpStatus, isResponse, NotFound, PreconditionFailed } from './http';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { Resource } from './resources';
import { Serialization, Serializer } from './serializers';
import { buildQuery } from './url';
import { mapCached } from './utils/arrays';
import { Key, pick } from './utils/objects';

const PRIMARY_KEY_FIELD = '_pk';

export class NeDbModel<S, PK extends Key<S>, V extends Key<S>> implements VersionedModel<S, PK, V, Query<S>> {

    private updateSerializer = this.serializer.partial([this.serializer.versionBy]);
    private identitySerializer = this.serializer.partial(this.serializer.identifyBy);
    private primaryKeySerializer = this.serializer.pick(this.serializer.identifyBy);
    private readonly decoder: Serializer<any, S>;
    private db = getDb(this.filePath);
    private defaultScanQuery: OrderedQuery<S, V> = {
        ordering: this.serializer.versionBy,
        direction: 'asc',
    };

    constructor(private filePath: string, public readonly serializer: Resource<S, PK, V>, defaults?: {[P in any]: S[any]}) {
        this.decoder = defaults ?
            // Decode by migrating the defaults
            this.serializer.defaults(defaults) :
            // Otherwise migrate with a possibility that there are missing properties
            this.serializer
        ;
        // Ensure uniqueness for the primary key (in addition to the built-in `_id` field)
        this.db.ensureIndex({
            fieldName: PRIMARY_KEY_FIELD,
            unique: true,
        });
    }

    public async retrieve(identity: Identity<S, PK, V>) {
        const query = this.getItemQuery(identity);
        const serializedItem = await this.findItem(query);
        if (!serializedItem) {
            throw new NotFound(`Item was not found.`);
        }
        return this.decoder.deserialize(serializedItem);
    }

    public async create(item: S) {
        const serializedItem = {
            ...this.serializer.serialize(item),
            [PRIMARY_KEY_FIELD]: this.getItemPrimaryKey(item),
        };
        try {
            await this.insertItem(serializedItem);
        } catch (error) {
            if (error.errorType === 'uniqueViolated') {
                throw new PreconditionFailed(`Item already exists.`);
            }
        }
        return item;
    }

    public async replace(identity: Identity<S, PK, V>, item: S) {
        const {serializer: resource} = this;
        const query = this.getItemQuery(identity);
        const serializedItem = {
            ...resource.serialize(item),
            [PRIMARY_KEY_FIELD]: this.getItemPrimaryKey(identity),
        };
        const updatedSerializedItem = await this.updateItem(query, serializedItem);
        if (!updatedSerializedItem) {
            throw new NotFound(`Item was not found.`);
        }
        return this.decoder.deserialize(updatedSerializedItem);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>): Promise<S> {
        const query = this.getItemQuery(identity);
        const serializedChanges = this.updateSerializer.serialize(changes);
        const updatedSerializedItem = await this.updateItem(query, {$set: serializedChanges});
        if (!updatedSerializedItem) {
            throw new NotFound(`Item was not found.`);
        }
        return this.decoder.deserialize(updatedSerializedItem);
    }

    public async amend<C extends PartialUpdate<S, V>>(identity: Identity<S, PK, V>, changes: C): Promise<C> {
        // TODO: Better performing implementation
        await this.update(identity, changes);
        return changes;
    }

    public async upsert(creation: S, update: PartialUpdate<S, V>): Promise<S> {
        try {
            return await this.create(creation);
        } catch (error) {
            if (isResponse(error, HttpStatus.PreconditionFailed)) {
                // Item already exists
                const { identifyBy } = this.serializer;
                const identity = pick(creation, identifyBy);
                // TODO: Handle race conditions
                return await this.update(identity as Identity<S, PK, V>, update);
            }
            throw error;
        }
    }

    public async write(item: S): Promise<S> {
        try {
            return await this.create(item);
        } catch (error) {
            if (!isResponse(error, HttpStatus.PreconditionFailed)) {
                throw error;
            }
            return await this.replace(
                pick(item, this.serializer.identifyBy) as Identity<S, PK, V>,
                item,
            );
        }
    }

    public async destroy(identity: Identity<S, PK, V>) {
        const query = this.getItemQuery(identity);
        const removedCount = await this.removeItem(query);
        if (!removedCount) {
            throw new NotFound(`Item was not found.`);
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        const query = this.getItemQuery(identity);
        await this.removeItem(query);
    }

    public async list<Q extends Query<S>>(query: Q): Promise<Page<S, Q>> {
        const { decoder } = this;
        const { fields } = this.serializer;
        const { ordering, direction, since, ...filterAttrs } = query;
        const filter: {[key: string]: any} = {};
        for (const key in filterAttrs) {
            if (filterAttrs.hasOwnProperty(key)) {
                const value = (filterAttrs as any)[key];
                const field = fields[key as keyof S];
                if (Array.isArray(value)) {
                    // Use IN operator
                    if (!value.length) {
                        // If an empty list, then there is no way this query would
                        // result in any rows, so terminate now.
                        return { results: [], next: null };
                    }
                    filter[key] = {
                        $in: value.map((item) => field.serialize(item)),
                    };
                } else {
                    filter[key] = field.serialize(value);
                }
            }
        }
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
                    next: {...query, since: cursor.since},
                };
            }
        }
    }
    public async *scan(query: Query<S> = this.defaultScanQuery): AsyncIterableIterator<S[]> {
        let next: Query<S> | null = query;
        while (next) {
            const page: Page<S, Query<S>> = await this.list(next);
            yield page.results;
            next = page.next;
        }
    }
    public batchRetrieve(identities: Array<Identity<S, PK, V>>) {
        const promises = mapCached(identities, (identity) => (
            this.retrieve(identity).catch((error) => {
                if (isResponse(error, HttpStatus.NotFound)) {
                    return null;
                }
                throw error;
            })
        ));
        return Promise.all(promises);
    }

    private findItem(query: {[key: string]: any}) {
        return new Promise<Serialization | null>((resolve, reject) => {
            this.db.findOne(query, promiseCallback(resolve, reject));
        });
    }
    private findItems(query: {[key: string]: unknown}, ordering: string, direction: 'asc' | 'desc', maxCount: number) {
        return new Promise<Serialization[]>((resolve, reject) => {
            this.db.find<Serialization>(query)
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
        return new Promise<Serialization | null>((resolve, reject) => {
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
