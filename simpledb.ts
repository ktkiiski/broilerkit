import map = require('lodash/map');
import 'rxjs/add/operator/toPromise';
import { AmazonSimpleDB, escapeQueryIdentifier, escapeQueryParam } from './aws/simpledb';
import { HashIndexQuery, Identity, Model, PartialUpdate, SlicedQuery, Table } from './db';
import { NotFound } from './http';
import { EncodedResource, Resource, Serializer } from './resources';
import { Diff, keys, omit, spread } from './utils/objects';

export type SimpleDbQuery<T, P extends keyof T> = SlicedQuery<T, keyof T> | HashIndexQuery<T, keyof T, P>;

export class SimpleDbTableDefinition<S, PK extends keyof S, V extends keyof S> implements Table<Model<S, PK, V, SimpleDbQuery<S, PK>>> {

    constructor(public name: string, public resource: Resource<S>, public readonly key: PK, public readonly versionAttr: V) {}

    public getModel(region: string, domainName: string): Model<S, PK, V, SimpleDbQuery<S, PK>> {
        return new SimpleDbModel<S, PK, V>(this, domainName, region);
    }
}

export class SimpleDbModel<S, PK extends keyof S, V extends keyof S> implements Model<S, PK, V, SimpleDbQuery<S, PK>> {

    private serializer = this.table.resource;
    private updateSerializer = this.serializer.optional<V, Diff<keyof S, PK | V>, never>({
        required: [this.table.versionAttr],
        optional: keys(this.table.resource.fields).filter((key) => key !== this.table.versionAttr),
        defaults: {},
    }) as Serializer<PartialUpdate<S, V>>;
    private identitySerializer = this.serializer.optional({
        required: [this.table.key],
        optional: [this.table.versionAttr],
        defaults: {},
    }) as Serializer<Identity<S, PK, V>>;

    constructor(public table: SimpleDbTableDefinition<S, PK, V>, private domainName: string, private region: string) {}

    public async retrieve(query: Identity<S, PK, V>, notFoundError?: Error) {
        const {table, identitySerializer, serializer} = this;
        const primaryKey = table.key;
        const encodedQuery = identitySerializer.encode(query);
        // TODO: Filter by version!
        const encodedId = encodedQuery[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItem = await sdb
            .getAttributes<EncodedResource>({
                DomainName: this.domainName,
                ItemName: encodedId,
            })
            .toPromise()
        ;
        if (!keys(encodedItem).length) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return serializer.decode(encodedItem);
    }

    public async create(item: S) {
        const {table, serializer} = this;
        const primaryKey = table.key;
        const encodedItem = serializer.encode(item);
        const encodedId = encodedItem[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        await sdb.putAttributes({
            DomainName: this.domainName,
            ItemName: encodedId,
            Expected: {
                Name: primaryKey,
                Exists: false,
            },
            Attributes: map(encodedItem, (value: any, attr) => ({
                Name: attr,
                Value: value,
                Replace: true,
            })),
        }).toPromise();
        return item;
    }

    public replace(identity: Identity<S, PK, V>, item: S, notFoundError?: Error) {
        // TODO: Implement separately
        const update = omit(item, [this.table.key]);
        return this.update(identity, update, notFoundError);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>, notFoundError?: Error): Promise<S> {
        // TODO: Patch specific version!
        const {table, serializer, identitySerializer, updateSerializer} = this;
        const primaryKey = table.key;
        const versionAttr = table.versionAttr;
        const encodedIdentity = identitySerializer.encode(identity);
        const encodedId = encodedIdentity[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        const encodedChanges = updateSerializer.encode(changes);
        // Get the current item's state
        const encodedItem = await sdb
            .getAttributes<EncodedResource>({
                DomainName: this.domainName,
                ItemName: encodedId,
            })
            .toPromise()
        ;
        if (!keys(encodedItem).length) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        const encodedVersion: string = encodedItem[versionAttr];
        const existingItem = serializer.decode(encodedItem);
        try {
            await sdb.putAttributes({
                DomainName: this.domainName,
                ItemName: encodedId,
                Expected: {
                    Name: versionAttr,
                    Value: encodedVersion,
                    Exists: true,
                },
                Attributes: map(encodedChanges, (value, attr) => ({
                    Name: attr,
                    Value: value,
                    Replace: true,
                })),
            }).toPromise();
        } catch (error) {
            if (error.code === 'ConditionalCheckFailed') {
                // Item was modified after it was read
                // TODO: Need to retry!?!
            }
            throw error;
        }
        return spread(existingItem, changes) as S;
    }

    public async amend<C extends PartialUpdate<S, V>>(identity: Identity<S, PK, V>, changes: C, notFoundError?: Error): Promise<C> {
        return await this.update(identity, changes, notFoundError) as any;
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public async destroy(identity: Identity<S, PK, V>, notFoundError?: Error) {
        const {table, identitySerializer} = this;
        const primaryKey = table.key;
        const encodedIdentity = identitySerializer.encode(identity);
        const encodedId = encodedIdentity[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        try {
            await sdb
                .deleteAttributes({
                    DomainName: this.domainName,
                    ItemName: encodedId,
                    Expected: {
                        Name: primaryKey,
                        Value: encodedId,
                        Exists: true,
                    },
                })
                .toPromise()
            ;
        } catch (error) {
            if (error.code === 'AttributeDoesNotExist' || error.code === 'MultiValuedAttribute' || error.code === 'ConditionalCheckFailed') {
                throw notFoundError || new NotFound(`Item was not found.`);
            }
            throw error;
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        // TODO: Better implementation!
        const notFound = new Error(`Not found`);
        try {
            return await this.destroy(identity, notFound);
        } catch (error) {
            if (error !== notFound) {
                throw error;
            }
        }
    }

    public async list(query: SimpleDbQuery<S, PK>) {
        const { serializer } = this;
        const { fields } = this.table.resource;
        const { ordering, direction, since } = query;
        const domain = this.domainName;
        const filters = [
            `${escapeQueryIdentifier(ordering)} is not null`,
        ];
        if (isIndexQuery<S, PK>(query)) {
            const { key, value } = query;
            const field = fields[key];
            const encodedValue = field.encode(value);
            filters.push(
                `${escapeQueryIdentifier(key)} == ${escapeQueryParam(encodedValue)}`,
            );
        }
        if (since) {
            const field = fields[ordering];
            const encodedValue = field.encode(since);
            filters.push([
                escapeQueryIdentifier(ordering),
                direction === 'asc' ? '>' : '<',
                escapeQueryParam(encodedValue),
            ].join(' '));
        }
        // TODO: Only select known fields
        const sql = `select * from ${escapeQueryIdentifier(domain)} where ${filters.join(' and ')} order by ${escapeQueryIdentifier(ordering)} ${direction} limit 100`;
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItems = await sdb.selectNext(sql, true).toPromise();
        return encodedItems.map((item) => serializer.decode(item.attributes));
    }
}

export function simpleDB<S>(tableName: string, resource: Resource<S>) {
    function identifyBy<K extends keyof S>(key: K) {
        function versionBy<V extends keyof S>(versionAttr: V) {
            return new SimpleDbTableDefinition(tableName, resource, key, versionAttr);
        }
        return {versionBy};
    }
    return {identifyBy};
}

function isIndexQuery<I, PK extends keyof I>(query: SimpleDbQuery<I, PK>): query is HashIndexQuery<I, keyof I, PK> {
    return (query as HashIndexQuery<I, keyof I, PK>).key != null;
}
