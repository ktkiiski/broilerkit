import { Field, nullable } from './fields';
import { Fields, FieldSerializer, nested, Serializer } from './serializers';
import { FilteredKeys, Key, omitUndefined, pick } from './utils/objects';

interface Join {
    resource: Resource<any, any, any>;
    on: {[pk: string]: string};
    fields: {[key: string]: string};
}

interface Nesting<R = any, PK extends Key<R> = any, T = any> {
    resource: Resource<R, PK, any>;
    on: {[P in PK]: FilteredKeys<T, R[PK]>};
}

type Relations<S = any, R extends {[name: string]: Resource<any, any, any>} = any> = {
    [P in keyof R]: Nesting<Deserialization<R[P]>, PrimaryKey<R[P]>, S>;
};

export interface Resource<T, PK extends Key<T>, V extends Key<T>> extends FieldSerializer<T> {
    readonly name: string;
    readonly identifyBy: PK[];
    readonly versionBy: V[];
    readonly columns: {[key: string]: Field<any>};
    readonly nestings: Relations<T>;
    readonly joins: Join[];
    subset<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): Resource<Pick<T, K>, PK & K, V & K>;
    /**
     * Join resource with another with an inner join.
     */
    join<S2, PK2 extends Key<S2>, U extends {[column: string]: Key<S2>}>(table: Resource<S2, PK2 & Key<S2>, any>, on: {[P in PK2 & Key<S2>]?: string & FilteredKeys<T, S2[P]>}, columns: U): Resource<T & {[P in Key<U>]: S2[U[P]]}, PK | (FilteredKeys<U, PK2> & string), V>;
    /**
     * Nest related resource as a property to this resource.
     * The join is a left join, meaning that the property
     * value will be null if the related resource does not exist.
     */
    nest<K extends string, S2, PK2 extends Key<S2>>(propertyName: K, resource: Resource<S2, PK2 & Key<S2>, any>, on: {[P in PK2 & Key<S2>]: string & FilteredKeys<T, S2[P]>}): Resource<T & Record<K, S2 | null>, PK, V>;
}

type PrimaryKey<R> = R extends Resource<any, infer PK, any> ? PK : never;

class FieldResource<T, PK extends Key<T>, V extends Key<T>> extends FieldSerializer<T> implements Resource<T, PK, V> {
    /**
     * @param name The identifying name of this type of resource.
     * @param columns Attribute names with their field definitions of the resource.
     * @param identifyBy Attributes whose values together uniquely identify resources.
     * @param versionBy Attribute whose value can be used to determine if the item's has updated.
     */
    constructor(
        public readonly name: string,
        public readonly columns: {[key: string]: Field<any>},
        public readonly identifyBy: PK[],
        public readonly versionBy: V[],
        public readonly nestings: {[key: string]: Nesting},
        public readonly joins: Join[],
    ) {
        super(buildFields(columns, nestings, joins));
    }
    public subset<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): FieldResource<Pick<T, K>, PK & K, V & K> {
        const { identifyBy } = this;
        if (!identifyBy.every((key) => (attrs as string[]).includes(key))) {
            throw new Error('Cannot omit identifying keys for a subset of a resource');
        }
        const versionBy = this.versionBy.filter((attr) => attrs.indexOf(attr as any) >= 0);
        return new FieldResource(
            this.name,
            pick(this.columns, attrs),
            identifyBy as Array<K & PK>,
            versionBy as Array<K & V>,
            pick(this.nestings, attrs),
            this.joins.map((join) => ({
                ...join,
                fields: pick(join.fields, attrs),
            })),
        );
    }

    public join<S2, PK2 extends Key<S2>>(
        other: Resource<S2, PK2 & Key<S2>, any>,
        on: {[P in any]?: string},
        fields: {[column: string]: string},
    ): Resource<any, any, any> {
        const joins: Join[] = this.joins.concat([{
            resource: other,
            fields,
            on: omitUndefined(on),
        }]);
        return new FieldResource(
            this.name, this.columns, this.identifyBy, this.versionBy, this.nestings, joins,
        );
    }
    public nest<K extends string, S2>(
        propertyName: K,
        other: Resource<S2, any, any>,
        on: {[key: string]: string},
    ): Resource<T & Record<K, S2 | null>, PK, V> {
        const nestings: {[key: string]: Nesting} = {
            ...this.nestings,
            [propertyName]: { resource: other, on },
        };
        return new FieldResource<T & Record<K, S2 | null>, PK, V>(
            this.name, this.columns, this.identifyBy, this.versionBy, nestings, this.joins,
        );
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

type ResourceFields<I, O> = {[P in keyof I]: Field<I[P], any>} & {[P in keyof O]: Field<any, O[P]>};

export function resource(name: string) {
    function fields<T, X>(columns: ResourceFields<T, X>) {
        function identifyBy<PK extends Key<T>, V extends Key<T> = never>(idKeys: PK[], versionKey?: V): Resource<T, PK, V> {
            return new FieldResource<T, PK, V>(name, columns, idKeys, versionKey != null ? [versionKey] : [], {}, []);
        }
        return { identifyBy };
    }
    return { fields };
}
