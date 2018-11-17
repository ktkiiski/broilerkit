import { choice, Field } from './fields';
import { Resource } from './resources';
import { Encoding, Serialization, Serializer } from './serializers';
import { findLastIndex } from './utils/arrays';
import { compare } from './utils/compare';
import { Key } from './utils/objects';

/**
 * Represents a paginated response to a query.
 */
export interface Page<T, C> {
    results: T[];
    next: C | null;
}

/**
 * Query parameters for getting an ordered slice of a collection.
 */
export type OrderedQuery<T, K extends keyof T> = {
    [P in K]: {
        ordering: P,
        direction: 'asc' | 'desc',
        since?: T[P],
    }
}[K];

/**
 * A "cursor" is a full query, including the ordering and slicing attributes,
 * and the filtering parameters, to get a page from a collection.
 */
export type Cursor<T, U extends keyof T, K extends keyof T> = Pick<T, U> & OrderedQuery<T, K>;

export class CursorSerializer<T, U extends Key<T>, K extends Key<T>> implements Serializer<Cursor<T, U, K>> {
    private serializer = this.resource.pick(this.urlKeywords).extend({
        ordering: choice(this.orderingKeys),
        direction: choice(['asc', 'desc']),
    });
    constructor(private resource: Resource<T, any>, private urlKeywords: U[], private orderingKeys: K[]) {}

    public validate(input: Cursor<T, U, K>): Cursor<T, U, K> {
        const validated = this.serializer.validate(input);
        return this.extendSince(validated, input.since, (field, since) => field.validate(since));
    }
    public serialize(input: Cursor<T, U, K>): Serialization {
        const serialized = this.serializer.serialize(input);
        return this.extendSince(serialized, input.since, (field, since) => field.serialize(since));
    }
    public deserialize(input: any): Cursor<T, U, K> {
        const deserialized = this.serializer.deserialize(input);
        return this.extendSince(deserialized, input.since, (field, since) => field.deserialize(since));
    }
    public encode(input: Cursor<T, U, K>): Encoding {
        const encoded = this.serializer.encode(input);
        return this.extendSince(encoded, input.since, (field, since) => field.encode(since));
    }
    public encodeSortable(input: Cursor<T, U, K>): Encoding {
        const encoded = this.serializer.encode(input);
        return this.extendSince(encoded, input.since, (field, since) => field.encodeSortable(since));
    }
    public decode(input: Encoding): Cursor<T, U, K> {
        const decoded = this.serializer.decode(input);
        return this.extendSince(decoded, input.since, (field, since) => field.decode(since));
    }
    public decodeSortable(input: Encoding): Cursor<T, U, K> {
        const decoded = this.serializer.decodeSortable(input);
        return this.extendSince(decoded, input.since, (field, since) => field.decodeSortable(since));
    }
    private extendSince(data: any, since: any, serialize: (field: Field<T[K], any>, since: any) => any) {
        const orderingField = this.resource.fields[data.ordering as Key<T>] as Field<T[K], any>;
        if (since !== undefined) {
            return {...data, since: serialize(orderingField, since)};
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
