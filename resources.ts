import { Fields, FieldSerializer } from './serializers';
import { Key, spread } from './utils/objects';

export class Resource<T, K extends Key<T>> extends FieldSerializer<T> {
    /**
     * @param fields Attribute names with their field definitions of the resource.
     * @param identifyBy Attributes whose values together uniquely identify resources.
     */
    constructor(fields: Fields<T>, public readonly identifyBy: K[]) {
        super(fields);
    }
    public extend<E>(fields: Fields<E>): Resource<T & E, K> {
        return new Resource(spread(this.fields, fields) as Fields<T & E>, this.identifyBy);
    }
}

export class VersionedResource<T, K extends Key<T>, V extends Key<T>> extends Resource<T, K> {
    /**
     * @param fields Attribute names with their field definitions of the resource.
     * @param identifyBy Attributes whose values together uniquely identify resources.
     * @param versionBy Attribute whose value can be used to determine if the item's has updated.
     */
    constructor(fields: Fields<T>, identifyBy: K[], public readonly versionBy: V) {
        super(fields, identifyBy);
    }
    public extend<E>(fields: Fields<E>): VersionedResource<T & E, K, V> {
        return new VersionedResource(spread(this.fields, fields) as Fields<T & E>, this.identifyBy, this.versionBy);
    }
}

export type Deserialization<T extends Resource<any, any>> = T extends Resource<infer R, any> ? R : any;

interface ResourceOptions<T, K extends Key<T>> {
    fields: Fields<T>;
    identifyBy: K[];
}

interface VersionedResourceOptions<T, K extends Key<T>, V extends Key<T>> {
    fields: Fields<T>;
    identifyBy: K[];
    versionBy: V;
}

export function resource<T, K extends Key<T>>(options: ResourceOptions<T, K>): Resource<T, K>;
export function resource<T, K extends Key<T>, V extends Key<T>>(options: VersionedResourceOptions<T, K, V>): VersionedResource<T, K, V>;
export function resource<T, K extends Key<T>, V extends Key<T>>(options: ResourceOptions<T, K> | VersionedResourceOptions<T, K, V>): Resource<T, K> | VersionedResourceOptions<T, K, V> {
    if ('versionBy' in options && options.versionBy != null) {
        return new VersionedResource<T, K, V>(options.fields, options.identifyBy, options.versionBy);
    }
    return new Resource<T, K>(options.fields, options.identifyBy);
}
