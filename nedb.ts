import { Identity, isIndexQuery, PartialUpdate, Query, VersionedModel } from './db';
import { NotFound } from './http';
import { Resource, SerializedResource } from './resources';
import { Key } from './utils/objects';

import * as Datastore from 'nedb';
import { mapCached } from './utils/arrays';

export class NeDbModel<S, PK extends Key<S>, V extends Key<S>> implements VersionedModel<S, PK, V, Query<S, PK>> {

    private updateSerializer = this.serializer.partial([this.versionAttr]);
    private identitySerializer = this.serializer.partial([this.key]);
    private db = getDb(this.filePath);

    constructor(private filePath: string, private serializer: Resource<S>, private key: PK, private versionAttr: V) {
        // Ensure uniqueness for the primary key (in addition to the built-in `_id` field)
        this.db.ensureIndex({
            fieldName: key,
            unique: true,
        });
    }

    public async retrieve(query: Identity<S, PK, V>, notFoundError?: Error) {
        const serializedIdentity = this.identitySerializer.serialize(query);
        const serializedItem = await this.findItem(serializedIdentity);
        if (!serializedItem) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return this.serializer.deserialize(serializedItem);
    }

    public async create(item: S, alreadyExistsError?: Error) {
        const serializedItem = this.serializer.serialize(item);
        try {
            await this.insertItem(serializedItem);
        } catch (error) {
            throw (error.errorType === 'uniqueViolated' && alreadyExistsError) || error;
        }
        return item;
    }

    public async replace(identity: Identity<S, PK, V>, item: S, notFoundError?: Error) {
        const {serializer} = this;
        const serializedIdentity = this.identitySerializer.serialize(identity);
        const serializedItem = serializer.serialize(item);
        const updatedSerializedItem = await this.updateItem(serializedIdentity, serializedItem);
        if (!updatedSerializedItem) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return serializer.deserialize(updatedSerializedItem);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>, notFoundError?: Error): Promise<S> {
        const serializedIdentity = this.identitySerializer.serialize(identity);
        const serializedChanges = this.updateSerializer.serialize(changes);
        const updatedSerializedItem = await this.updateItem(serializedIdentity, {$set: serializedChanges});
        if (!updatedSerializedItem) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return this.serializer.deserialize(updatedSerializedItem);
    }

    public async amend<C extends PartialUpdate<S, V>>(identity: Identity<S, PK, V>, changes: C, notFoundError?: Error): Promise<C> {
        // TODO: Better performing implementation
        await this.update(identity, changes, notFoundError);
        return changes;
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public async destroy(identity: Identity<S, PK, V>, notFoundError?: Error) {
        const serializedIdentity = this.identitySerializer.serialize(identity);
        const removedCount = await this.removeItem(serializedIdentity);
        if (!removedCount) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        const serializedIdentity = this.identitySerializer.serialize(identity);
        await this.removeItem(serializedIdentity);
    }

    public async list(query: Query<S, PK>) {
        const { serializer } = this;
        const { fields } = serializer;
        const { ordering, direction, since } = query;
        const filter: {[key: string]: any} = {};
        if (isIndexQuery<S, PK>(query)) {
            const { key, value } = query;
            const field = fields[key];
            filter[key] = field.serialize(value);
        }
        if (since !== undefined) {
            const field = fields[ordering];
            filter[ordering] = {
                [direction === 'asc' ? '$gt' : '$lt']: field.serialize(since),
            };
        }
        const serializedItems = await this.findItems(filter, ordering, direction, query.maxCount);
        return serializedItems.map((serializedItem) => serializer.deserialize(serializedItem));
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
