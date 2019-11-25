import { Field } from './fields';
import { UnionToIntersection } from './react/client';
import { Fields, FieldSerializer, Serializer } from './serializers';
import { buildObject, Key, keys, pick, toPairs, transformValues } from './utils/objects';

type ResourceFields<I, O> = {[P in keyof I]: Field<I[P], any>} & {[P in keyof O]: Field<any, O[P]>};

export interface Resource<T, PK extends Key<T>, V extends Key<T>> extends FieldSerializer<T> {
    readonly name: string;
    readonly identifyBy: PK[];
    readonly versionBy: V[];
    subset<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): FieldResource<Pick<T, K>, PK & K, V & K>;
    expand<E>(fields: Fields<E>): Resource<T & E, PK, V>;
}

class FieldResource<T, PK extends Key<T>, V extends Key<T>> extends FieldSerializer<T> implements Resource<T, PK, V> {
    /**
     * @param name The identifying name of this type of resource.
     * @param fields Attribute names with their field definitions of the resource.
     * @param identifyBy Attributes whose values together uniquely identify resources.
     * @param versionBy Attribute whose value can be used to determine if the item's has updated.
     */
    constructor(
        public readonly name: string,
        fields: Fields<T>,
        public readonly identifyBy: PK[],
        public readonly versionBy: V[]) {
        super(fields);
    }
    public subset<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): FieldResource<Pick<T, K>, PK & K, V & K> {
        const { identifyBy } = this;
        if (!identifyBy.every((key) => (attrs as string[]).includes(key))) {
            throw new Error('Cannot omit identifying keys for a subset of a resource');
        }
        const versionBy = this.versionBy.filter((attr) => attrs.indexOf(attr as any) >= 0);
        return new FieldResource(
            this.name,
            pick(this.fields, attrs) as Fields<Pick<T, K | PK>>,
            identifyBy as Array<K & PK>,
            versionBy as Array<K & V>,
        );
    }
    public expand<E>(fields: Fields<E>): FieldResource<T & E, PK, V> {
        return new FieldResource(this.name, {...this.fields, ...fields} as Fields<T & E>, this.identifyBy, this.versionBy);
    }
}

export type Deserialization<T extends Serializer<any, any>> = T extends Serializer<infer R> ? R : any;

interface ResourceOptions<T, X, PK extends Key<T>, V extends Key<T>> {
    name: string;
    fields: ResourceFields<T, X>;
    identifyBy: PK[];
    versionBy?: V;
}

export function resource<T, X, PK extends Key<T>, V extends Key<T> = never>(options: ResourceOptions<T, X, PK, V>): FieldResource<T, PK, V> {
    return new FieldResource(options.name, options.fields, options.identifyBy, options.versionBy ? [options.versionBy] : []);
}

type FilteredKeys<T, Condition> = { [P in keyof T]: T[P] extends Condition ? P : never }[keyof T];

interface RelationOptions<T, PK extends Key<T>, R extends Record<PK, any>, F> {
    resource: Resource<T, PK, any>;
    relation: R;
    fields: F;
}

interface Relation<T, R, F> {
    resource: Resource<T, any, any>;
    fieldMapping: {[P in keyof R | keyof F]: Key<T>};
    relationMapping: {[P in keyof R]: Key<T>};
    filterMapping: {[P in keyof F]: Key<T>};
}

export type JunctionIdentity<R> = UnionToIntersection<R[number & keyof R]>;
export type Junction<R, F> = JunctionIdentity<R> & UnionToIntersection<F[number & keyof F]>;

export function relation<T, PK extends Key<T>, RK extends string, R extends Record<PK, RK>, FK extends Exclude<Key<T>, PK>, EK extends string, F extends {[P in FK]?: EK}>(
    // tslint:disable-next-line:no-shadowed-variable
    {resource, relation, fields}: RelationOptions<T, PK, R, F>,
): Relation<T, {[P in R[keyof R]]: T[FilteredKeys<R, P> & keyof T] }, {[P in Exclude<F[keyof F], undefined>]: T[FilteredKeys<F, P> & keyof T] }> {
    const filterMapping: any = buildObject(
        toPairs(fields), ([srcKey, key]) => [key as string, srcKey as string],
    );
    const relationMapping: any = buildObject(
        toPairs(relation), ([srcKey, key]) => [key as string, srcKey as string],
    );
    const fieldMapping = {...filterMapping, ...relationMapping};
    return {resource, filterMapping, relationMapping, fieldMapping};
}

export class JunctionResource<T, R, F> extends FieldResource<Junction<R, F>, Key<JunctionIdentity<R>>, never> {
    constructor(
        public readonly relations: JunctionOptions<T, R, F>,
        name: string,
        fields: Fields<Junction<R, F>>,
        identifyBy: Array<Key<JunctionIdentity<R>>>,
    ) {
        super(name, fields, identifyBy, []);
    }
}

type JunctionOptions<T, R, F> = {[P in keyof T]: Relation<T[P], any, any>} & {[P in keyof R]: Relation<any, R[P], any>} & {[P in keyof F]: Relation<any, any, F[P]>};

export function junction<T extends any[], R extends any[], F extends any[]>(
    ...options: JunctionOptions<T, R, F>
) {
    const resultFields = {} as Fields<Junction<R, F>>;
    const identifyBy: string[] = [];
    for (const option of options) {
        const fields = transformValues(option.fieldMapping, (key) => (
            option.resource.fields[key]
        ));
        Object.assign(resultFields, fields);
        keys(option.relationMapping).forEach((relationAttr) => {
            if (identifyBy.indexOf(relationAttr) < 0) {
                identifyBy.push(relationAttr);
            }
        });
    }
    return new JunctionResource<T, R, F>(
        options,
        options.map((rel) => rel.resource.name).join('+'),
        resultFields,
        identifyBy as Array<Key<JunctionIdentity<R>>>,
    );
}
