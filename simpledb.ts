import { AmazonSimpleDB, escapeQueryIdentifier, escapeQueryParam } from './aws/simpledb';
import { Identity, isIndexQuery, PartialUpdate, Query, VersionedModel } from './db';
import { NotFound } from './http';
import { EncodedResource, Resource } from './resources';
import { hasAttributes } from './utils/compare';
import { Key, keys, mapObject, omit, spread } from './utils/objects';

export class SimpleDbModel<S, PK extends Key<S>, V extends Key<S>> implements VersionedModel<S, PK, V, Query<S, PK>> {

    private updateSerializer = this.serializer.partial([this.versionAttr]);
    private identitySerializer = this.serializer.pick([this.key, this.versionAttr]).partial([this.key]);

    constructor(private domainName: string, private region: string, private serializer: Resource<S>, private key: PK, private versionAttr: V) {}

    public async retrieve(query: Identity<S, PK, V>, notFoundError?: Error) {
        const {identitySerializer, serializer} = this;
        const primaryKey = this.key;
        const encodedQuery = identitySerializer.encode(query);
        const encodedId = encodedQuery[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItem = await sdb.getAttributes<EncodedResource>({
            DomainName: this.domainName,
            ItemName: encodedId,
            ConsistentRead: true,
        });
        if (!hasAttributes(encodedItem, encodedQuery)) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return serializer.decode(encodedItem);
    }

    // TODO: Already exists exception??
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
            Attributes: mapObject(encodedItem, (value: any, attr) => ({
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
        return this.update(identity, update as PartialUpdate<S, V>, notFoundError);
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
        if (!hasAttributes(encodedItem, encodedIdentity)) {
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
                Attributes: mapObject(encodedChanges, (value, attr) => ({
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
        // TODO: Better performing implementation
        await this.update(identity, changes, notFoundError);
        return changes;
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public async destroy(identity: Identity<S, PK, V>, notFoundError?: Error) {
        const {identitySerializer} = this;
        const primaryKey = this.key;
        const versionAttr = this.versionAttr;
        const encodedIdentity = identitySerializer.encode(identity);
        const encodedId = encodedIdentity[primaryKey];
        let encodedVersion = encodedIdentity[versionAttr];
        const otherFilters = omit(encodedIdentity, [primaryKey, versionAttr]);
        const sdb = new AmazonSimpleDB(this.region);
        // If there are other filters, then we first need to check if the
        // instance matches these filtering criteria.
        if (keys(otherFilters).length) {
            // Get the current item's state
            const encodedItem = await sdb.getAttributes<EncodedResource>({
                DomainName: this.domainName,
                ItemName: encodedId,
            });
            if (!hasAttributes(encodedItem, encodedIdentity)) {
                throw notFoundError || new NotFound(`Item was not found.`);
            }
            // For the next deletion, use the given version ID
            // TODO: Retry conflicts?
            encodedVersion = encodedItem[versionAttr];
        }
        try {
            await sdb.deleteAttributes({
                DomainName: this.domainName,
                ItemName: encodedId,
                Expected: {
                    Name: encodedVersion == null ? primaryKey : versionAttr,
                    Value: encodedVersion == null ? encodedId : encodedVersion,
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
        const { fields } = serializer;
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
        if (since !== undefined) {
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
