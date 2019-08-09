import { AmazonSimpleDB, escapeQueryIdentifier, escapeQueryParam } from './aws/simpledb';
import { Identity, PartialUpdate, Query, VersionedModel } from './db';
import { HttpStatus, isErrorResponse, isResponse, NotFound, PreconditionFailed } from './http';
import { OrderedQuery, Page, prepareForCursor } from './pagination';
import { Resource } from './resources';
import { Encoding, Serializer } from './serializers';
import { buildQuery } from './url';
import { deal, flatten } from './utils/arrays';
import { hasProperties } from './utils/compare';
import { Key, keys, mapObject, omit, pick } from './utils/objects';

interface Chunk<T> {
    items: T[];
    isComplete: boolean;
}

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

    public async retrieve(query: Identity<S, PK, V>) {
        const {identitySerializer, decoder} = this;
        const encodedQuery = identitySerializer.encodeSortable(query);
        const itemName = this.getItemName(encodedQuery);
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItem = await sdb.getAttributes<Encoding>({
            DomainName: this.domainName,
            ItemName: itemName,
            ConsistentRead: true,
        });
        if (!hasProperties(encodedItem, encodedQuery)) {
            throw new NotFound(`Item was not found.`);
        }
        return decoder.decodeSortable(encodedItem);
    }

    public async create(item: S) {
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
                throw new PreconditionFailed(`Item already exists.`);
            }
            throw error;
        }
        return item;
    }

    public replace(identity: Identity<S, PK, V>, item: S) {
        // TODO: Implement separately
        const update = omit(item, this.serializer.identifyBy);
        return this.update(identity, update as PartialUpdate<S, V>);
    }

    public async update(identity: Identity<S, PK, V>, changes: PartialUpdate<S, V>): Promise<S> {
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
        if (!hasProperties(encodedItem, encodedIdentity)) {
            throw new NotFound(`Item was not found.`);
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
        return {...existingItem, ...changes} as S;
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

    public async destroy(identity: Identity<S, PK, V>) {
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
            if (!hasProperties(encodedItem, encodedIdentity)) {
                throw new NotFound(`Item was not found.`);
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
                throw new NotFound(`Item was not found.`);
            }
            throw error;
        }
    }

    public async clear(identity: Identity<S, PK, V>) {
        // TODO: Better implementation!
        try {
            return await this.destroy(identity);
        } catch (error) {
            if (!isResponse(error, HttpStatus.NotFound)) {
                throw error;
            }
        }
    }

    public async list<Q extends Query<S>>(query: Q): Promise<Page<S, Q>> {
        const { ordering, direction } = query;
        const results: S[] = [];
        for await (const {items, isComplete} of this.scanChunks(query)) {
            results.push(...items);
            if (isComplete) {
                return { results: items, next: null };
            }
            const cursor = prepareForCursor(results, ordering, direction);
            if (cursor) {
                return {
                    results: cursor.results,
                    next: {...query, since: cursor.since},
                };
            }
        }
        // No more items
        return {results, next: null};
    }

    public async batchRetrieve(identities: Array<Identity<S, PK, V>>): Promise<Array<S | null>> {
        if (!identities.length) {
            return [];
        }
        // SimpleDB only allows max 20 conditions per request (including IN clauses).
        // Therefore split (recursively) if there are more than 20 identities.
        if (identities.length > 20) {
            const promises = deal(identities, 20).map(async (chunk) => this.batchRetrieve(chunk));
            return flatten(await Promise.all(promises));
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
        for await (const {items} of sdb.select(sql, true)) {
            for (const item of items) {
                itemsByName[item.name] = decoder.decodeSortable(item.attributes);
            }
        }
        return itemNames.map((itemName) => itemName in itemsByName ? itemsByName[itemName] : null);
    }

    public async *scan(query: Query<S> = this.defaultScanQuery): AsyncIterableIterator<S[]> {
        for await (const {items} of this.scanChunks(query)) {
            yield items;
        }
    }

    private async *scanChunks(query: Query<S> = this.defaultScanQuery): AsyncIterableIterator<Chunk<S>> {
        const { decoder } = this;
        const { fields } = this.serializer;
        const { ordering, direction, since, ...filterAttrs } = query;
        const domain = this.domainName;
        const filters = [
            `${escapeQueryIdentifier(ordering)} is not null`,
        ];
        for (const key in filterAttrs) {
            if (filterAttrs.hasOwnProperty(key)) {
                const value = (filterAttrs as any)[key];
                const field = fields[key as keyof S];
                if (Array.isArray(value)) {
                    // Use IN operator
                    if (!value.length) {
                        // If an empty list, then there is no way this query would
                        // result in any rows, so terminate now.
                        yield { items: [], isComplete: true };
                        return;
                    }
                    const escapedValues = value.map((item) => escapeQueryParam(
                        field.encodeSortable(item),
                    ));
                    // TODO: This will break there are more than 20 conditions!
                    filters.push(
                        `${escapeQueryIdentifier(key)} in (${escapedValues.join(',')})`,
                    );
                } else {
                    const encodedValue = field.encodeSortable(value);
                    filters.push(
                        `${escapeQueryIdentifier(key)} = ${escapeQueryParam(encodedValue)}`,
                    );
                }
            }
        }
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
        for await (const {items, isComplete} of sdb.select(sql, true)) {
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
            yield {items: results, isComplete};
        }
    }

    private getItemName(encodedQuery: Encoding): string {
        const key = this.serializer.identifyBy;
        if (key.length === 1) {
            return encodedQuery[key[0]];
        }
        return buildQuery(pick(encodedQuery, key));
    }
}
