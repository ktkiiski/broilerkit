import { Field, list } from './fields';
import { ValidationError } from './http';
import { difference } from './utils/arrays';
import { forEachKey, Key, keys, omit, Omit, Optional, pick, Require, spread } from './utils/objects';

export type Fields<T> = {
    [P in keyof T]: Field<T[P], any>;
};

export interface SerializedResource {
    [key: string]: any;
}

export interface EncodedResource {
    [key: string]: string;
}

export interface Serializer<I = any, O = I> {
    validate(input: I): O;
    serialize(input: I): SerializedResource;
    deserialize(input: any): O;
    encode(input: I): EncodedResource;
    decode(input: EncodedResource): O;
    encodeSortable(input: I): EncodedResource;
    decodeSortable(input: EncodedResource): O;
}

export class Resource<T> implements Serializer<T> {
    constructor(public readonly fields: Fields<T>) {}

    public pick<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): Resource<Pick<T, K>> {
        return new Resource(pick(this.fields, attrs) as Fields<Pick<T, K>>);
    }
    public omit<K extends Key<T>>(attrs: K[]): Resource<Omit<T, K>> {
        return new Resource(omit(this.fields, attrs) as Fields<Omit<T, K>>);
    }
    public partial<K extends Key<T>>(attrs: K[]): Serializer<Require<T, K>> {
        return this.optional({
            required: attrs,
            optional: difference(keys(this.fields), attrs),
            defaults: {},
        }) as Serializer<Require<T, K>>;
    }
    public fullPartial(): Serializer<Partial<T>> {
        return this.optional({
            required: [],
            optional: keys(this.fields),
            defaults: {},
        });
    }
    public optional<R extends Key<T>, O extends Key<T>, D extends Key<T>>(options: OptionalOptions<T, R, O, D>): OptionalSerializer<T, R, O, D> {
        return new OptionalSerializer(options, this.fields);
    }
    public extend<E>(fields: Fields<E>): Resource<T & E> {
        return new Resource(spread(this.fields, fields) as Fields<T & E>);
    }
    public validate(input: T): T {
        return serializeWith(this.fields, input, (field, value) => field.validate(value)) as T;
    }
    public serialize(input: T): SerializedResource {
        return serializeWith(this.fields, input, (field, value) => field.serialize(value));
    }
    public encode(input: T): EncodedResource {
        return serializeWith(this.fields, input, (field, value) => field.encode(value));
    }
    public encodeSortable(input: T): EncodedResource {
        return serializeWith(this.fields, input, (field, value) => field.encodeSortable(value));
    }
    public deserialize(input: any): T {
        return this.deserializeWith(input, (field, value) => field.deserialize(value));
    }
    public decode(input: EncodedResource): T {
        return this.deserializeWith(input, (field, value) => field.decode(value));
    }
    public decodeSortable(input: EncodedResource): T {
        return this.deserializeWith(input, (field, value) => field.decodeSortable(value));
    }
    private deserializeWith(input: any, callback: (field: Field<T[Key<T>]>, value: any, key: Key<T>) => T[Key<T>]): T {
        if (!input || typeof input !== 'object') {
            throw new ValidationError(`Invalid object`);
        }
        const {fields} = this;
        const output = {} as Partial<T>;
        // Deserialize each field
        forEachKey(fields, (key, field) => {
            const value = input[key];
            if (value === undefined) {
                // TODO: Gather errors
                throw new ValidationError(`Missing required value for "${key}"`);
            } else {
                output[key as keyof T] = callback(field, value, key);
            }
        });
        return output as T;
    }
}

export type Deserialization<T extends Resource<any>> = T extends Resource<infer R> ? R : any;

export interface OptionalOptions<S, R extends Key<S>, O extends Key<S>, D extends Key<S>> {
    required: R[];
    optional: O[];
    defaults: {[P in D]: S[P]};
}

export type OptionalInput<S, R extends Key<S>, O extends Key<S>, D extends Key<S>> = Optional<Pick<S, R | O | D>, O | D>;
export type OptionalOutput<S, R extends Key<S>, O extends Key<S>, D extends Key<S>> = Optional<Pick<S, R | O | D>, O>;

export class OptionalSerializer<S, R extends Key<S>, O extends Key<S>, D extends Key<S>> implements Serializer<OptionalInput<S, R, O, D>, OptionalOutput<S, R, O, D>> {
    private readonly requiredFields: R[];
    private readonly optionalFields: Array<O | D>;
    private readonly defaults: {[P in D]: S[P]};

    constructor(options: OptionalOptions<S, R, O, D>, private fields: Fields<S>) {
        const {required, optional, defaults} = options;
        this.requiredFields = required;
        this.optionalFields = [...optional, ...keys(defaults)];
        this.defaults = defaults;
    }

    public validate(input: OptionalInput<S, R, O, D>): OptionalOutput<S, R, O, D> {
        return this.deserializeWith(input, (field, value) => field.validate(value));
    }
    public serialize(input: OptionalInput<S, R, O, D>): SerializedResource {
        return serializeWith(this.fields, input, (field, value) => field.serialize(value));
    }
    public encode(input: OptionalInput<S, R, O, D>): EncodedResource {
        return serializeWith(this.fields, input, (field, value) => field.encode(value));
    }
    public encodeSortable(input: OptionalInput<S, R, O, D>): EncodedResource {
        return serializeWith(this.fields, input, (field, value) => field.encodeSortable(value));
    }
    public deserialize(input: any): OptionalOutput<S, R, O, D> {
        return this.deserializeWith(input, (field, value) => field.deserialize(value));
    }
    public decode(input: EncodedResource): OptionalOutput<S, R, O, D> {
        return this.deserializeWith(input, (field, value) => field.decode(value));
    }
    public decodeSortable(input: EncodedResource): OptionalOutput<S, R, O, D> {
        return this.deserializeWith(input, (field, value) => field.decodeSortable(value));
    }
    private deserializeWith(input: any, callback: (field: Field<S[Key<S>]>, value: any) => S[Key<S>]): OptionalOutput<S, R, O, D> {
        if (!input || typeof input !== 'object') {
            throw new ValidationError(`Invalid object`);
        }
        const {fields} = this;
        const output = spread(this.defaults) as {[key in R | O | D]: any};
        // Deserialize each required field
        for (const key of this.requiredFields) {
            const value = input[key];
            if (value === undefined) {
                // TODO: Gather errors
                throw new ValidationError(`Missing required value for "${key}"`);
            }
            output[key] = fields[key].serialize(value);
        }
        // Deserialize optional fields
        for (const key of this.optionalFields) {
            const value = input[key];
            if (value !== undefined) {
                output[key] = callback(fields[key], value);
            }
        }
        return output;
    }
}

class NestedResourceField<T> extends Resource<T> implements Field<T, any> {
    // tslint:disable-next-line:no-shadowed-variable
    public encode(_: T): never {
        throw new Error('Nested resource field does not support encoding.');
    }
    public encodeSortable(_: T): never {
        throw new Error('Nested resource field does not support sortable encoding.');
    }
    public decode(_: any): never {
        throw new Error('Nested resource field does not support decoding.');
    }
    public decodeSortable(_: any): never {
        throw new Error('Nested resource field does not support sortable decoding.');
    }
}

export function resource<T>(fields: Fields<T>) {
    return new Resource<T>(fields);
}

export function nested<T>(res: Resource<T>): Field<T, any> {
    return new NestedResourceField(res.fields);
}

export function nestedList<T>(res: Resource<T>): Field<T[], any[]> {
    return list(nested(res));
}

function serializeWith<T>(fields: {[key: string]: Field<any>}, input: {[key: string]: any}, serializeField: (field: Field<any>, value: any, key: string) => T): {[key: string]: T} {
    const output: {[key: string]: T} = {};
    for (const key in fields) {
        if (fields.hasOwnProperty(key)) {
            const value = input[key];
            if (value !== undefined) {
                output[key] = serializeField(fields[key], value, key);
            }
        }
    }
    return output;
}
