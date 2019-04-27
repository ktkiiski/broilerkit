import { Fields, FieldSerializer, Serializer } from './serializers';
import { Key, pick } from './utils/objects';

export class Resource<T, PK extends Key<T>, V extends Key<T> | undefined> extends FieldSerializer<T> {
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
        public readonly versionBy: V) {
        super(fields);
    }
    public expose<K extends Exclude<Key<T> & Key<Fields<T>>, PK>>(attrs: K[]): Resource<Pick<T, K | PK>, PK, V extends K ? V : undefined> {
        const versionBy = attrs.indexOf(this.versionBy as any) >= 0 ? this.versionBy : undefined;
        return new Resource(this.name, pick(this.fields, [...attrs, ...this.identifyBy]) as Fields<Pick<T, K | PK>>, this.identifyBy, versionBy as V extends K ? V : undefined);
    }
    public expand<E>(fields: Fields<E>): Resource<T & E, PK, V> {
        return new Resource(this.name, {...this.fields, ...fields} as Fields<T & E>, this.identifyBy, this.versionBy);
    }
}

export type Deserialization<T extends Serializer<any, any>> = T extends Serializer<infer R> ? R : any;

interface ResourceOptions<T, PK extends Key<T>, V extends Key<T> | undefined> {
    name: string;
    fields: Fields<T>;
    identifyBy: PK[];
    versionBy?: V;
}

export function resource<T, PK extends Key<T>, V extends Key<T> | undefined = undefined>(options: ResourceOptions<T, PK, V>): Resource<T, PK, V> {
    return new Resource(options.name, options.fields, options.identifyBy, options.versionBy as V);
}
