/* eslint-disable @typescript-eslint/no-explicit-any */
import isDefined from 'immuton/isDefined';
import pick from 'immuton/pick';
import select from 'immuton/select';
import type { FilteredKeys, Key } from 'immuton/types';
import union from 'immuton/union';
import { Field, nullable } from './fields';
import { Fields, FieldSerializer, nested, Serializer } from './serializers';
import { buildQuery } from './url';

type JoinCondition = string | { value: any };

interface BaseJoin {
    resource: Resource<any, any, any>;
    on: { [pk: string]: JoinCondition };
    fields: { [key: string]: string };
}

interface InnerJoin extends BaseJoin {
    type: 'inner';
}

interface LeftJoin extends BaseJoin {
    type: 'left';
    defaults: { [key: string]: any };
}

export type Join = InnerJoin | LeftJoin;

interface Nesting<R = any, PK extends Key<R> = any, T = any> {
    resource: Resource<R, PK, any>;
    on: { [P in PK]: FilteredKeys<T, R[PK]> & string };
}

type Relations<S = any, R extends { [name: string]: Resource<any, any, any> } = any> = {
    [P in keyof R]: Nesting<Deserialization<R[P]>, PrimaryKey<R[P]>, S>;
};

export interface Resource<T, PK extends Key<T>, W extends Key<T>> extends FieldSerializer<T> {
    readonly name: string;
    readonly identifyBy: PK[];
    readonly columns: { [key: string]: Field<any> };
    readonly nestings: Relations<T>;
    readonly joins: Join[];
    readonly identifier: Serializer<Pick<T, PK>>;
    readonly writer: FieldSerializer<Pick<T, W>>;

    subset<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): Resource<Pick<T, K>, PK & K, W & K>;
    /**
     * Join another resource with an inner join.
     */
    join<S2, PK2 extends Key<S2>, U extends { [column: string]: Key<S2> }>(
        table: Resource<S2, PK2 & Key<S2>, any>,
        on: { [P in PK2 & Key<S2>]?: (string & FilteredKeys<T, S2[P]>) | { value: S2[P] } },
        columns: U,
    ): Resource<T & { [P in Key<U>]: S2[U[P]] }, PK | (FilteredKeys<U, PK2> & string), W | Key<U>>;
    /**
     * Join another resource with an left outer join.
     */
    leftJoin<S2, PK2 extends Key<S2>, U extends { [column: string]: Key<S2> }>(
        table: Resource<S2, PK2 & Key<S2>, any>,
        on: { [P in PK2 & Key<S2>]?: (string & FilteredKeys<T, S2[P]>) | { value: S2[P] } },
        columns: U,
        defaults: { [P in keyof U]: S2[U[P]] },
    ): Resource<T & { [P in Key<U>]: S2[U[P]] }, PK | (FilteredKeys<U, PK2> & string), W>;
    /**
     * Nest related resource as a property to this resource.
     * The join is a left join, meaning that the property
     * value will be null if the related resource does not exist.
     */
    nest<K extends string, S2, PK2 extends Key<S2>>(
        propertyName: K,
        resource: Resource<S2, PK2 & Key<S2>, any>,
        on: { [P in PK2 & Key<S2>]: string & FilteredKeys<T, S2[P]> },
    ): Resource<T & Record<K, S2 | null>, PK, W>;

    getUniqueId(item: Pick<T, PK>): string;
}

type PrimaryKey<R> = R extends Resource<any, infer PK, any> ? PK : never;

class FieldResource<T, PK extends Key<T>, W extends Key<T>> extends FieldSerializer<T> implements Resource<T, PK, W> {
    public readonly identifier: Serializer<Pick<T, PK>>;

    public readonly writer: FieldSerializer<Pick<T, W>>;

    /**
     * @param name The identifying name of this type of resource.
     * @param columns Attribute names with their field definitions of the resource.
     * @param identifyBy Attributes whose values together uniquely identify resources.
     */
    constructor(
        public readonly name: string,
        public readonly columns: { [key: string]: Field<any> },
        public readonly identifyBy: PK[],
        public readonly nestings: { [key: string]: Nesting },
        public readonly joins: Join[],
    ) {
        super(buildFields(columns, nestings, joins));
        this.identifier = this.pick(this.identifyBy);
        this.writer = new FieldSerializer(columns as any);
    }

    public subset<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): FieldResource<Pick<T, K>, PK & K, W & K> {
        const { identifyBy } = this;
        if (!identifyBy.every((key) => (attrs as string[]).includes(key))) {
            throw new Error('Cannot omit identifying keys for a subset of a resource');
        }
        return new FieldResource(
            this.name,
            pick(this.columns, attrs),
            identifyBy as (K & PK)[],
            pick(this.nestings, attrs),
            this.joins.map((join) =>
                join.type === 'inner'
                    ? {
                          ...join,
                          fields: pick(join.fields, attrs),
                      }
                    : {
                          ...join,
                          fields: pick(join.fields, attrs),
                          defaults: pick(join.defaults, attrs),
                      },
            ),
        );
    }

    public join<S2, PK2 extends Key<S2>>(
        other: Resource<S2, PK2 & Key<S2>, any>,
        on: { [P in PK2 & Key<S2>]?: (string & FilteredKeys<T, S2[P]>) | { value: S2[P] } },
        fields: { [column: string]: string },
    ): Resource<any, any, string> {
        const joinBy = select(on, isDefined);
        const joins: Join[] = this.joins.concat([
            {
                type: 'inner',
                resource: other,
                fields,
                on: joinBy,
            },
        ]);
        const newPkKeys = Object.values(joinBy).filter((pk) => typeof pk === 'string') as string[];
        const identifyBy = union([this.identifyBy, newPkKeys]);
        return new FieldResource(this.name, this.columns, identifyBy, this.nestings, joins);
    }

    public leftJoin<S2, PK2 extends Key<S2>>(
        other: Resource<S2, PK2 & Key<S2>, any>,
        on: { [P in PK2 & Key<S2>]?: (string & FilteredKeys<T, S2[P]>) | { value: S2[P] } },
        fields: { [column: string]: string },
        defaults: { [column: string]: any },
    ): Resource<any, any, W> {
        const joins: Join[] = this.joins.concat([
            {
                type: 'left',
                resource: other,
                fields,
                on: select(on, isDefined),
                defaults,
            },
        ]);
        return new FieldResource(this.name, this.columns, this.identifyBy, this.nestings, joins);
    }

    public nest<K extends string, S2>(
        propertyName: K,
        other: Resource<S2, any, any>,
        on: { [key: string]: string },
    ): Resource<T & Record<K, S2 | null>, PK, W> {
        const nestings: { [key: string]: Nesting } = {
            ...this.nestings,
            [propertyName]: { resource: other, on },
        };
        return new FieldResource<T & Record<K, S2 | null>, PK, W>(
            this.name,
            this.columns,
            this.identifyBy,
            nestings,
            this.joins,
        );
    }

    public getUniqueId(item: Pick<T, PK>): string {
        const identity = this.identifier.encode(item);
        return `${this.name}?${buildQuery(identity)}`;
    }
}

function buildFields(columns: Fields, nestings: Relations, joins: Join[]): Fields {
    const fields = { ...columns };
    for (const key of Object.keys(nestings)) {
        const nesting = nestings[key];
        fields[key] = nullable(nested(nesting.resource));
    }
    for (const join of joins) {
        for (const key of Object.keys(join.fields)) {
            const sourceKey = join.fields[key];
            fields[key] = join.resource.fields[sourceKey];
        }
    }
    return fields;
}

export type Deserialization<T extends Serializer<any, any>> = T extends Serializer<infer R> ? R : any;

type ResourceFields<I, O> = { [P in keyof I]: Field<I[P], any> } & { [P in keyof O]: Field<any, O[P]> };

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function resource(name: string) {
    function fields<T, X>(columns: ResourceFields<T, X>) {
        function identifyBy<PK extends Key<T>>(...idKeys: PK[]): Resource<T, PK, Key<T>> {
            return new FieldResource<T, PK, Key<T>>(name, columns, idKeys, {}, []);
        }
        return { identifyBy };
    }
    return { fields };
}
