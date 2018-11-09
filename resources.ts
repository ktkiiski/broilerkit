import { Field, list } from './fields';
import { ValidationError } from './http';
import { difference } from './utils/arrays';
import { forEachKey, Key, keys, omit, Omit, pick, Require, spread } from './utils/objects';

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
    deserialize(input: unknown): O;
    encode(input: I): EncodedResource;
    decode(input: EncodedResource): O;
    encodeSortable(input: I): EncodedResource;
    decodeSortable(input: EncodedResource): O;
}

type FieldConverter = (field: Field<any>, value: any, key: any) => any;

abstract class BaseSerializer<T, S> implements Serializer<T, S> {
    protected abstract readonly fields: Fields<T>;

    public validate(input: T): S {
        return this.serializeWith(input, (field, value) => field.validate(value)) as S;
    }
    public serialize(input: T): SerializedResource {
        return this.serializeWith(input, (field, value) => field.serialize(value));
    }
    public encode(input: T): EncodedResource {
        return this.serializeWith(input, (field, value) => field.encode(value));
    }
    public encodeSortable(input: T): EncodedResource {
        return this.serializeWith(input, (field, value) => field.encodeSortable(value));
    }
    public deserialize(input: unknown): S {
        return this.deserializeWith(input, (field, value) => field.deserialize(value));
    }
    public decode(input: EncodedResource): S {
        return this.deserializeWith(input, (field, value) => field.decode(value));
    }
    public decodeSortable(input: EncodedResource): S {
        return this.deserializeWith(input, (field, value) => field.decodeSortable(value));
    }
    protected serializeWith<V>(input: {[key: string]: any}, serializeField: (field: Field<any>, value: any, key: string) => V): {[key: string]: V} {
        const fields: {[key: string]: Field<any>} = this.fields;
        const output: {[key: string]: V} = {};
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
    protected deserializeWith(input: unknown, callback: FieldConverter): S {
        if (typeof input !== 'object' || !input) {
            throw new ValidationError(`Invalid object`);
        }
        const fields: {[key: string]: Field<any>} = this.fields;
        const output = {} as Partial<S>;
        // Deserialize each field
        forEachKey(fields, (key, field) => {
            const rawValue = (input as any)[key];
            const value = this.deserializeFieldWith(field, rawValue, key, callback);
            if (typeof value !== 'undefined') {
                output[key as keyof S] = value;
            }
        });
        return output as S;
    }
    protected deserializeFieldWith(field: Field<any>, value: any, key: any, callback: FieldConverter): any {
        if (value === undefined) {
            // TODO: Gather errors
            throw new ValidationError(`Missing required value for "${key}"`);
        } else {
            return callback(field, value, key);
        }
    }
}

export class Resource<T> extends BaseSerializer<T, T> implements Serializer<T> {
    constructor(public readonly fields: Fields<T>) {
        super();
    }
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
    public optional<R extends Key<T>, O extends Key<T>, D extends keyof T>(options: OptionalOptions<T, R, O, D>): Serializer<OptionalInput<T, R, O, D>, OptionalOutput<T, R, O, D>> {
        return new OptionalSerializer(options, this.fields);
    }
    public defaults<D extends keyof T>(defaults: {[P in D]: T[P]}): DefaultsSerializer<T, D> {
        return new DefaultsSerializer(defaults, this.fields);
    }
    public extend<E>(fields: Fields<E>): Resource<T & E> {
        return new Resource(spread(this.fields, fields) as Fields<T & E>);
    }
}

export type Deserialization<T extends Resource<any>> = T extends Resource<infer R> ? R : any;

export interface OptionalOptions<S, R extends keyof S, O extends Key<S>, D extends keyof S> {
    required: R[];
    optional: O[];
    defaults: {[P in D]: S[P]};
}

export type OptionalInput<S, R extends keyof S, O extends Key<S>, D extends keyof S> = Pick<S, R> & Partial<Pick<S, O | D>>;
export type OptionalOutput<S, R extends keyof S, O extends Key<S>, D extends keyof S> = Pick<S, R | D> & Partial<Pick<S, O>>;

export class OptionalSerializer<S, R extends keyof S, O extends Key<S>, D extends keyof S> extends BaseSerializer<OptionalInput<S, R, O, D>, OptionalOutput<S, R, O, D>> {
    private readonly requiredFields: R[];
    private readonly optionalFields: Array<O | D>;
    private readonly defaults: {[P in D]: S[P]};

    constructor(options: OptionalOptions<S, R, O, D>, protected fields: Fields<S>) {
        super();
        const {required, optional, defaults} = options;
        this.requiredFields = required;
        this.optionalFields = [...optional, ...keys(defaults)];
        this.defaults = defaults;
    }

    protected deserializeFieldWith(field: Field<any>, value: any, key: any, callback: FieldConverter): any {
        if (typeof value === 'undefined') {
            // Value is missing
            const defaultValue = this.defaults[key as D];
            if (typeof defaultValue !== 'undefined') {
                // Return the default value
                return defaultValue;
            }
            if (this.optionalFields.indexOf(key) >= 0) {
                // Allow this value to be undefined
                return value;
            }
        }
        // Otherwise deserialize normally if a required field
        if (this.requiredFields.indexOf(key) >= 0) {
            return super.deserializeFieldWith(field, value, key, callback);
        }
        // Otherwise this should be omitted
    }
}

export class DefaultsSerializer<S, D extends keyof S> extends BaseSerializer<Pick<S, Exclude<keyof S, D> & Partial<Pick<S, D>>>, S> {
    constructor(private readonly defaults: {[P in D]: S[P]}, protected fields: Fields<S>) {
        super();
    }

    protected deserializeFieldWith(field: Field<any>, value: any, key: any, callback: FieldConverter): any {
        if (typeof value === 'undefined') {
            // Value is missing
            const defaultValue = this.defaults[key as D];
            if (typeof defaultValue !== 'undefined') {
                // Return the default value
                return defaultValue;
            }
        }
        // Otherwise deserialize normally
        return super.deserializeFieldWith(field, value, key, callback);
    }
}

class NestedSerializerField<I> implements Field<I, SerializedResource> {
    constructor(private serializer: Serializer<I, any>) {}
    public validate(value: I): I {
        return this.serializer.validate(value);
    }
    public serialize(value: I): SerializedResource {
        return this.serializer.serialize(value);
    }
    public deserialize(value: unknown): I {
        return this.serializer.deserialize(value);
    }
    public encode(_: I): never {
        throw new Error('Nested resource field does not support encoding.');
    }
    public encodeSortable(_: I): never {
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

export function nested<I>(res: Serializer<I, any>): Field<I, EncodedResource> {
    return new NestedSerializerField(res);
}

export function nestedList<I>(res: Serializer<I, any>): Field<I[], EncodedResource[]> {
    return list(nested(res));
}
