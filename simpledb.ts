import { AmazonSimpleDB, escapeQueryIdentifier, escapeQueryParam } from './aws/simpledb';
import { Identity, PartialUpdate, Query, VersionedModel } from './db';
import { isErrorResponse, NotFound } from './http';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { Resource } from './resources';
import { Encoding, Serializer } from './serializers';
import { buildQuery } from './url';
import { hasAttributes } from './utils/compare';
import { forEachKey, Key, keys, mapObject, omit, pick, spread } from './utils/objects';

export class SimpleDbModel<S, PK extends Key<S>, V extends Key<S>> implements VersionedModel<S, PK, V, Query<S>> {

    private updateSerializer = this.serializer.partial([this.serializer.versionBy]);
    private identitySerializer = this.serializer.pick([...this.serializer.identifyBy, this.serializer.versionBy]).partial(this.serializer.identifyBy);
    private readonly decoder: Serializer<any, S>;
    private defaultScanQuery: OrderedQuery<S, V> = {
        ordering: this.serializer.versionBy,
        direction: 'asc',
    };

    constructor(private domainName: string, private region: string, public readonly serializer: Resource<S, PK, V>, defaults?: {[P in any]: S[any]}) {
        this.decoder = defaults ?
            // Decode by migrating the defaults
            this.serializer.defaults(defaults) :
            // Otherwise migrate with a possibility that there are missing properties
            this.serializer
        ;
    }

    public async retrieve(query: Identity<S, PK, V>, notFoundError?: Error) {
        const {identitySerializer, decoder} = this;
        const encodedQuery = identitySerializer.encodeSortable(query);
        const itemName = this.getItemName(encodedQuery);
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItem = await sdb.getAttributes<Encoding>({
            DomainName: this.domainName,
            ItemName: itemName,
            ConsistentRead: true,
        });
        if (!hasAttributes(encodedItem, encodedQuery)) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return decoder.decodeSortable(encodedItem);
    }

    // TODO: Already exists exception??
    public async create(item: S, alreadyExistsError?: Error) {
        const {serializer: resource} = this;
        const primaryKey = this.serializer.identifyBy;
        const encodedItem = resource.encodeSortable(item);
        const itemName = this.getItemName(encodedItem);
        const sdb = new AmazonSimpleDB(this.region);
        try {
            await sdb.putAttributes({
                DomainName: this.domainName,
                ItemName: itemName,
                Expected: {
                    Name: primaryKey[0],
                    Exists: false,
                },
                Attributes: mapObject(encodedItem, (value, attr) => ({
                    Name: attr,
                    Value: value,
                    Replace: true,
                })),
            });
        } catch (error) {
            if (error.code === 'ConditionalCheckFailed') {
                throw alreadyExistsError || new NotFound(`Item was not found.`);
            }
            throw error;
        }
        return item;
    }

    public replace(identity: Identity<S, PK, V>, item: S, notFoundError?: Error) {
        // TODO: Implement separately
        const update = omit(item, this.serializer.identifyBy);
        return this.update(identity, update as PartialUpdate<S, V>, notFoundError);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>, notFoundError?: Error): Promise<S> {
        // TODO: Patch specific version!
        const {decoder, identitySerializer, updateSerializer} = this;
        const versionAttr = this.serializer.versionBy;
        const encodedIdentity = identitySerializer.encodeSortable(identity);
        const encodedId = this.getItemName(encodedIdentity);
        const sdb = new AmazonSimpleDB(this.region);
        const encodedChanges = updateSerializer.encodeSortable(changes);
        // Get the current item's state
        const encodedItem = await sdb.getAttributes<Encoding>({
            DomainName: this.domainName,
            ItemName: encodedId,
        });
        if (!hasAttributes(encodedItem, encodedIdentity)) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        const encodedVersion: string = encodedItem[versionAttr];
        const existingItem = decoder.decodeSortable(encodedItem);
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

    public async write(item: S): Promise<S> {
        const {serializer: resource} = this;
        const encodedItem = resource.encodeSortable(item);
        const itemName = this.getItemName(encodedItem);
        const sdb = new AmazonSimpleDB(this.region);
        await sdb.putAttributes({
            DomainName: this.domainName,
            ItemName: itemName,
            Attributes: mapObject(encodedItem, (value, attr) => ({
                Name: attr,
                Value: value,
                Replace: true,
            })),
        });
        return item;
    }

    public async destroy(identity: Identity<S, PK, V>, notFoundError?: Error) {
        const {identitySerializer} = this;
        const primaryKey = this.serializer.identifyBy;
        const versionAttr = this.serializer.versionBy;
        const encodedIdentity = identitySerializer.encodeSortable(identity);
        const itemName = this.getItemName(encodedIdentity);
        let encodedVersion = encodedIdentity[versionAttr];
        const otherFilters = omit(encodedIdentity, [...primaryKey, versionAttr]);
        const sdb = new AmazonSimpleDB(this.region);
        // If there are other filters, then we first need to check if the
        // instance matches these filtering criteria.
        if (keys(otherFilters).length) {
            // Get the current item's state
            const encodedItem = await sdb.getAttributes<Encoding>({
                DomainName: this.domainName,
                ItemName: itemName,
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
                ItemName: itemName,
                Expected: {
                    Name: encodedVersion == null ? primaryKey[0] : versionAttr,
                    Value: encodedVersion == null ? encodedIdentity[primaryKey[0]] : encodedVersion,
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

    public async list<Q extends Query<S>>(query: Q): Promise<Page<S, Q>> {
        const { ordering, direction } = query;
        const results: S[] = [];
        for await (const items of this.scan(query)) {
            results.push(...items);
            const cursor = prepareForCursor(results, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: spread(query, {since: cursor.since}),
                };
            }
        }
        // No more items
        return {results, next: null};
    }

    public async *scan(query: Query<S> = this.defaultScanQuery): AsyncIterableIterator<S[]> {
        const { decoder } = this;
        const { fields } = this.serializer;
        const { ordering, direction, since } = query;
        const filterAttrs = omit(query as {[key: string]: any}, ['ordering', 'direction', 'since']) as Partial<S>;
        const domain = this.domainName;
        const filters = [
            `${escapeQueryIdentifier(ordering)} is not null`,
        ];
        forEachKey(filterAttrs, (key: any, value: any) => {
            const field = (fields as any)[key];
            const encodedValue = field.encodeSortable(value);
            filters.push(
                `${escapeQueryIdentifier(key)} = ${escapeQueryParam(encodedValue)}`,
            );
        });
        if (since !== undefined) {
            const field = fields[ordering];
            const encodedValue = field.encodeSortable(since);
            filters.push([
                escapeQueryIdentifier(ordering),
                direction === 'asc' ? '>' : '<',
                escapeQueryParam(encodedValue),
            ].join(' '));
        }
        const sql = `select * from ${escapeQueryIdentifier(domain)} where ${filters.join(' and ')} order by ${escapeQueryIdentifier(ordering)} ${direction} limit 100`;
        const sdb = new AmazonSimpleDB(this.region);
        for await (const items of sdb.select(sql, true)) {
            const results: S[] = [];
            items.forEach((item) => {
                try {
                    results.push(decoder.decodeSortable(item.attributes));
                } catch (error) {
                    // Validation errors indicate corrupted data. Just ignore them.
                    if (!isErrorResponse(error)) {
                        throw error;
                    }
                }
            });
            yield results;
        }
    }

    public async batchRetrieve(identities: Array<Identity<S, PK, V>>) {
        if (!identities.length) {
            return [];
        }
        const {identitySerializer} = this;
        const itemNames = identities.map((identity) => (
            this.getItemName(identitySerializer.encodeSortable(identity))
        ));
        const escapedItemNames = itemNames.map((itemName) => escapeQueryParam(itemName));
        const { decoder } = this;
        const domain = this.domainName;
        const filters = [
            `itemName() in (${escapedItemNames.join(',')})`,
        ];
        const sql = `select * from ${escapeQueryIdentifier(domain)} where ${filters.join(' and ')}`;
        const sdb = new AmazonSimpleDB(this.region);
        const itemsByName: {[name: string]: S} = {};
        for await (const items of sdb.select(sql, true)) {
            for (const item of items) {
                itemsByName[item.name] = decoder.decodeSortable(item.attributes);
            }
        }
        return itemNames.map((itemName) => itemName in itemsByName ? itemsByName[itemName] : null);
    }

    private getItemName(encodedQuery: Encoding): string {
        const key = this.serializer.identifyBy;
        if (key.length === 1) {
            return encodedQuery[key[0]];
        }
        return buildQuery(pick(encodedQuery, key));
    }
}
