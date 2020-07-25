/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
import compare from 'immuton/compare';
import findLastIndex from 'immuton/findLastIndex';
import type { Key } from 'immuton/types';
import { choice, Field } from './fields';
import type { Resource } from './resources';
import type { Encoding, Serialization, Serializer } from './serializers';

type PageCursor<C extends OrderedQuery<any, any, any>> = C & { since: Exclude<C['since'], undefined> };

/**
 * Represents a paginated response to a query.
 */
export interface Page<T, C extends OrderedQuery<T, any, any>> {
    results: T[];
    next: PageCursor<C> | null;
}

/**
 * Query parameters for getting an ordered slice of a collection.
 */
export type OrderedQuery<T, O extends keyof T, D extends 'asc' | 'desc' = 'asc' | 'desc'> = {
    [P in O]: {
        ordering: P;
        direction: D;
        since?: T[P];
    };
}[O];

export type PageResponse<T> = Page<T, OrderedQuery<T, Key<T>> & Partial<T>>;

/**
 * A "cursor" is a full query, including the ordering and slicing attributes,
 * and the filtering parameters, to get a page from a collection.
 */
export type Cursor<T, U extends keyof T, O extends keyof T, F extends keyof T> = Pick<T, U> &
    Partial<Pick<T, F>> &
    OrderedQuery<T, O>;

export class CursorSerializer<T, U extends Key<T>, O extends Key<T>, F extends Key<T>>
    implements Serializer<Cursor<T, U, O, F>> {
    private serializer = this.resource
        .optional({
            required: this.urlKeywords,
            optional: this.filteringKeys,
            defaults: {},
        })
        .extend({
            ordering: choice(this.orderingKeys),
            direction: choice(['asc', 'desc']),
        });
    constructor(
        private resource: Resource<T, any, any>,
        private urlKeywords: U[],
        private orderingKeys: O[],
        private filteringKeys: F[],
    ) {}

    public validate(input: Cursor<T, U, O, F>): Cursor<T, U, O, F> {
        const validated = this.serializer.validate(input);
        return this.extendSince(validated, input.since, (field, since) => field.validate(since));
    }
    public serialize(input: Cursor<T, U, O, F>): Serialization {
        const serialized = this.serializer.serialize(input);
        return this.extendSince(serialized, input.since, (field, since) => field.serialize(since));
    }
    public deserialize(input: any): Cursor<T, U, O, F> {
        const deserialized = this.serializer.deserialize(input);
        return this.extendSince(deserialized, input.since, (field, since) => field.deserialize(since));
    }
    public encode(input: Cursor<T, U, O, F>): Encoding {
        const encoded = this.serializer.encode(input);
        return this.extendSince(encoded, input.since, (field, since) => field.encode(since));
    }
    public encodeSortable(input: Cursor<T, U, O, F>): Encoding {
        const encoded = this.serializer.encode(input);
        return this.extendSince(encoded, input.since, (field, since) => field.encodeSortable(since));
    }
    public decode(input: Encoding): Cursor<T, U, O, F> {
        const decoded = this.serializer.decode(input);
        return this.extendSince(decoded, input.since, (field, since) => field.decode(since));
    }
    public decodeSortable(input: Encoding): Cursor<T, U, O, F> {
        const decoded = this.serializer.decodeSortable(input);
        return this.extendSince(decoded, input.since, (field, since) => field.decodeSortable(since));
    }
    private extendSince(data: any, since: any, serialize: (field: Field<T[O], any>, since: any) => any) {
        const orderingField = this.resource.fields[data.ordering as Key<T>] as Field<T[O], any>;
        if (since !== undefined) {
            return { ...data, since: serialize(orderingField, since) };
        }
        return data;
    }
}

export function prepareForCursor<T>(results: T[], ordering: Key<T>, direction: 'asc' | 'desc') {
    const lastItem = results[results.length - 1];
    if (lastItem) {
        const lastIndex = findLastIndex(
            results,
            (result) => compare(result[ordering], lastItem[ordering], direction) < 0,
        );
        if (lastIndex >= 0) {
            return {
                results: results.slice(0, lastIndex + 1),
                since: results[lastIndex][ordering],
            };
        }
    }
    return null;
}
