import keys = require('lodash/keys');
import map = require('lodash/map');
import mapValues = require('lodash/mapValues');
import pickBy = require('lodash/pickBy');
import 'rxjs/add/operator/toPromise';
import { __assign } from 'tslib';
import { AmazonSimpleDB, escapeQueryIdentifier, escapeQueryParam } from './aws/simpledb';
import { HashIndexQuery, Model, SlicedQuery, Table } from './db';
import { Field, optional } from './fields';
import { NotFound } from './http';
import { EncodedResource, FieldMapping, ResourceFieldSet, SortableEncoderSerializer } from './resources';

export type SimpleDbQuery<T, P extends keyof T> = SlicedQuery<T, keyof T> | HashIndexQuery<T, keyof T, P>;

export class BaseSimpleDbTable<E, I> {
    constructor(protected name: string, protected attrs: ResourceFieldSet<E, I>) { }

    public attributes<E2, I2>(attributes: ResourceFieldSet<E2, I2>) {
        return new BaseSimpleDbTable<E2, I2>(this.name, attributes);
    }

    public identify<PK extends keyof E & keyof I, V extends keyof E & keyof I>(primaryKey: PK, versionAttr: V): Table<Model<I, PK, V, SimpleDbQuery<I, PK>>> {
        return new SimpleDbTableDefinition(this.name, this.attrs, primaryKey, versionAttr);
    }
}

export class SimpleDbTableDefinition<E, I, PK extends keyof E & keyof I, V extends keyof E & keyof I> implements Table<Model<I, PK, V, SimpleDbQuery<I, PK>>> {

    public serializer: SortableEncoderSerializer<E, I>;

    constructor(public name: string, attrs: ResourceFieldSet<E, I>, public readonly key: PK, public readonly versionAttr: V) {
        this.serializer = new SortableEncoderSerializer(
            mapValues(
                attrs as FieldMapping,
                (field, attr) => attr === key || attr === versionAttr ? field : optional(field),
            ) as ResourceFieldSet<E, I>,
        );
    }

    public getModel(region: string, domainName: string): Model<I, PK, V, SimpleDbQuery<I, PK>> {
        return new SimpleDbModel<E, I, PK, V>(this, domainName, region);
    }
}

export class SimpleDbModel<E, I, PK extends keyof E & keyof I, V extends keyof E & keyof I> implements Model<I, PK, V, SimpleDbQuery<I, PK>> {

    constructor(public table: SimpleDbTableDefinition<E, I, PK, V>, private domainName: string, private region: string) {
    }

    public async retrieve(query: Pick<I, PK>, notFoundError?: Error) {
        const {table} = this;
        const primaryKey = table.key;
        const id = query[primaryKey];
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItem = await sdb
            .getAttributes<EncodedResource<I>>({
                DomainName: this.domainName,
                ItemName: this.encodeId(id),
            })
            .toPromise()
        ;
        if (!keys(encodedItem).length) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        return this.decodeItem(encodedItem);
    }

    public async create(item: I) {
        const {table} = this;
        const primaryKey = table.key;
        const encodedItem = this.encodeItem(item);
        const encodedId = (encodedItem as Pick<EncodedResource<E>, PK>)[primaryKey];
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

    public put(identity: Pick<I, PK> | Pick<I, V | PK>, item: I, notFoundError?: Error) {
        // TODO: Implement separately
        return this.patch(identity, item as any, notFoundError);
    }

    public async patch(identity: Pick<I, PK> | Pick<I, V | PK>, item: Partial<I> & Pick<I, V>, notFoundError?: Error) {
        const {table} = this;
        const primaryKey = table.key;
        const versionAttr = table.versionAttr;
        const fields: FieldMapping = table.serializer.fields;
        const id = (identity as Pick<I, PK>)[primaryKey];
        const encodedId = this.encodeId(id);
        const sdb = new AmazonSimpleDB(this.region);
        const filteredItem: {[key: string]: any} = pickBy(item, (_, key) => fields[key] != null);
        // Get the current item's state
        const encodedItem = await sdb
            .getAttributes<EncodedResource<I>>({
                DomainName: this.domainName,
                ItemName: encodedId,
            })
            .toPromise()
        ;
        const encodedVersion: string = encodedItem[versionAttr];
        const existingItem = this.decodeItem(encodedItem);
        if (!keys(existingItem).length) {
            throw notFoundError || new NotFound(`Item was not found.`);
        }
        try {
            await sdb.putAttributes({
                DomainName: this.domainName,
                ItemName: encodedId,
                Expected: {
                    Name: versionAttr,
                    Value: encodedVersion,
                    Exists: true,
                },
                Attributes: map(filteredItem, (value, attr) => ({
                    Name: attr,
                    Value: fields[attr].encodeSortable(value),
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
        return __assign({}, existingItem, item) as I;
    }

    public async patchUp<C extends Partial<I> & Pick<I, V>>(identity: Pick<I, PK> | Pick<I, V | PK>, changes: C, notFoundError?: Error): Promise<C> {
        return await this.patch(identity, changes, notFoundError) as any;
    }

    public async write(_: I): Promise<I> {
        throw new Error(`Not yet implemented!`);
    }

    public async destroy(identity: Pick<I, PK>, notFoundError?: Error) {
        const {table} = this;
        const primaryKey = table.key;
        const id = identity[primaryKey];
        const encodedId = this.encodeId(id);
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

    public async clear(identity: Pick<I, PK>) {
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

    public async list(query: SimpleDbQuery<I, PK>) {
        const { table } = this;
        const { ordering, direction, since } = query;
        const fields: FieldMapping = table.serializer.fields;
        const orderingField = fields[ordering];
        const domain = this.domainName;
        const filters = [
            `${escapeQueryIdentifier(ordering)} is not null`,
        ];
        if (isIndexQuery<I, PK>(query)) {
            const { key, value } = query;
            const keyField = fields[key];
            filters.push(
                `${escapeQueryIdentifier(key)} == ${escapeQueryParam(keyField.encodeSortable(value))}`,
            );
        }
        if (since) {
            filters.push([
                escapeQueryIdentifier(ordering),
                direction === 'asc' ? '>' : '<',
                escapeQueryParam(orderingField.encodeSortable(since)),
            ].join(' '));
        }
        // TODO: Only select known fields
        const sql = `select * from ${escapeQueryIdentifier(domain)} where ${filters.join(' and ')} order by ${escapeQueryIdentifier(ordering)} ${direction} limit 100`;
        const sdb = new AmazonSimpleDB(this.region);
        const encodedItems = await sdb.selectNext(sql, true).toPromise();
        return encodedItems.map((item) => this.decodeItem(item.attributes as EncodedResource<I>));
    }

    private decodeItem(encodedItem: EncodedResource<I>) {
        return this.table.serializer.input(encodedItem) as any as I;
    }

    private encodeItem(item: I) {
        return this.table.serializer.output(item);
    }

    private encodeId(id: I[PK]): string {
        const {table} = this;
        const fields: FieldMapping = table.serializer.fields;
        const primaryKey = table.key;
        const primaryKeyField: Field<E[PK], I[PK]> = fields[primaryKey];
        return primaryKeyField.encodeSortable(id);
    }
}

export function simpleDB(tableName: string) {
    return new BaseSimpleDbTable(tableName, {});
}

function isIndexQuery<I, PK extends keyof I>(query: SimpleDbQuery<I, PK>): query is HashIndexQuery<I, keyof I, PK> {
    return (query as HashIndexQuery<I, keyof I, PK>).key != null;
}
