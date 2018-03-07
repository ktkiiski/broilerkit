import map = require('lodash/map');
import { AmazonSimpleDB, escapeQueryIdentifier, escapeQueryParam } from './aws/simpledb';
import { HashIndexQuery, Identity, Model, PartialUpdate, Query } from './db';
import { NotFound } from './http';
import { EncodedResource, Resource, Serializer } from './resources';
import { Diff, keys, omit, spread } from './utils/objects';

export class SimpleDbModel<S, PK extends keyof S, V extends keyof S> implements Model<S, PK, V, Query<S, PK>> {

    private serializer = this.resource;
    private updateSerializer = this.serializer.optional<V, Diff<keyof S, PK | V>, never>({
        required: [this.versionAttr],
        optional: keys(this.resource.fields).filter((key) => key !== this.versionAttr),
        defaults: {},
    }) as Serializer<PartialUpdate<S, V>>;
    private identitySerializer = this.serializer.optional({
        required: [this.key],
        optional: [this.versionAttr],
        defaults: {},
    }) as Serializer<Identity<S, PK, V>>;

    constructor(private domainName: string, private region: string, private resource: Resource<S>, private key: PK, private versionAttr: V) {}

    public async retrieve(query: Identity<S, PK, V>, notFoundError?: Error) {
        const {identitySerializer, serializer} = this;
        const primaryKey = this.key;
        const encodedQuery = identitySerializer.encode(query);
        // TODO: Filter by version!
        const encodedId = encodedQuery[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItem = await sdb.getAttributes<EncodedResource>({
            DomainName: this.domainName,
            ItemName: encodedId,
        });
        if (!keys(encodedItem).length) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return serializer.decode(encodedItem);
    }

    public async create(item: S) {
        const {serializer} = this;
        const primaryKey = this.key;
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
        });
        return item;
    }

    public replace(identity: Identity<S, PK, V>, item: S, notFoundError?: Error) {
        // TODO: Implement separately
        const update = omit(item, [this.key]);
        return this.update(identity, update, notFoundError);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>, notFoundError?: Error): Promise<S> {
        // TODO: Patch specific version!
        const {serializer, identitySerializer, updateSerializer} = this;
        const primaryKey = this.key;
        const versionAttr = this.versionAttr;
        const encodedIdentity = identitySerializer.encode(identity);
        const encodedId = encodedIdentity[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        const encodedChanges = updateSerializer.encode(changes);
        // Get the current item's state
        const encodedItem = await sdb.getAttributes<EncodedResource>({
            DomainName: this.domainName,
            ItemName: encodedId,
        });
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
            });
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
        const {identitySerializer} = this;
        const primaryKey = this.key;
        const encodedIdentity = identitySerializer.encode(identity);
        const encodedId = encodedIdentity[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        try {
            await sdb.deleteAttributes({
                DomainName: this.domainName,
                ItemName: encodedId,
                Expected: {
                    Name: primaryKey,
                    Value: encodedId,
                    Exists: true,
                },
            });
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

    public async list(query: Query<S, PK>) {
        const { serializer } = this;
        const { fields } = this.resource;
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
        const encodedItems = await sdb.selectNext(sql, true);
        return encodedItems.map((item) => serializer.decode(item.attributes));
    }
}

function isIndexQuery<I, PK extends keyof I>(query: Query<I, PK>): query is HashIndexQuery<I, keyof I, PK> {
    return (query as HashIndexQuery<I, keyof I, PK>).key != null;
}
