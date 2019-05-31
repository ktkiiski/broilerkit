import { KeyErrorData, ValidationError } from './errors';
import { Field, list } from './fields';
import { isErrorResponse } from './http';
import { difference } from './utils/arrays';
import { forEachKey, Key, keys, omit, pick, Require } from './utils/objects';

export type Fields<T> = {
    [P in keyof T]: Field<T[P], any>;
};

export interface Serialization {
    [key: string]: any;
}

export interface Encoding {
    [key: string]: string;
}

export interface Serializer<I = any, O = I> {
    validate(input: I): O;
    serialize(input: I): Serialization;
    deserialize(input: unknown): O;
    encode(input: I): Encoding;
    decode(input: Encoding): O;
    encodeSortable(input: I): Encoding;
    decodeSortable(input: Encoding): O;
}

interface ExtendableSerializer<I, O = I> extends Serializer<I, O> {
    extend<E>(fields: Fields<E>): ExtendableSerializer<I & E, O & E>;
}

type FieldConverter<T = any> = (field: Field<any>, value: any, key: any) => T;

abstract class BaseSerializer<T, S> implements Serializer<T, S> {
    protected abstract readonly fields: Fields<T>;

    public serialize(input: T): Serialization {
        return this.transformWith(input, (field, value) => field.serialize(value));
    }
    public encode(input: T): Encoding {
        return this.transformWith(input, (field, value) => field.encode(value));
    }
    public encodeSortable(input: T): Encoding {
        return this.transformWith(input, (field, value) => field.encodeSortable(value));
    }
    public validate(input: T): S {
        return this.transformWith(input, (field, value) => field.validate(value)) as S;
    }
    public deserialize(input: unknown): S {
        return this.transformWith(input, (field, value) => field.deserialize(value));
    }
    public decode(input: Encoding): S {
        return this.transformWith(input, (field, value) => field.decode(value));
    }
    public decodeSortable(input: Encoding): S {
        return this.transformWith(input, (field, value) => field.decodeSortable(value));
    }
    protected transformFieldWith(field: Field<any>, value: any, key: any, callback: FieldConverter): any {
        if (typeof value === 'undefined') {
            throw new ValidationError(`Missing required value`);
        }
        return callback(field, value, key);
    }
    private transformWith(input: any, callback: FieldConverter): any {
        if (typeof input !== 'object' || !input) {
            throw new ValidationError(`Invalid object`);
        }
        const fields: {[key: string]: Field<any>} = this.fields;
        const output: {[key: string]: any} = {};
        const errors: Array<KeyErrorData<string>> = [];
        // Deserialize each field
        forEachKey(fields, (key, field) => {
            const rawValue = input[key];
            try {
                const value = this.transformFieldWith(field, rawValue, key, callback);
                if (typeof value !== 'undefined') {
                    output[key] = value;
                }
            } catch (error) {
                // Collect nested validation errors
                if (isErrorResponse(error)) {
                    errors.push({...error.data, key});
                } else {
                    // Pass this error through, causing an internal server error
                    throw error;
                }
            }
        });
        if (errors.length) {
            // Invalid data -> throw validation error that contains nested errors
            throw new ValidationError(`Invalid fields`, errors);
        }
        return output;
    }
}

export class FieldSerializer<T> extends BaseSerializer<T, T> implements ExtendableSerializer<T> {
    constructor(public readonly fields: Fields<T>) {
        super();
    }
    public pick<K extends Key<T> & Key<Fields<T>>>(attrs: K[]): FieldSerializer<Pick<T, K>> {
        return new FieldSerializer(pick(this.fields, attrs) as Fields<Pick<T, K>>);
    }
    public omit<K extends Key<T>>(attrs: K[]): FieldSerializer<Omit<T, K>> {
        return new FieldSerializer(omit(this.fields, attrs) as Fields<Omit<T, K>>);
    }
    public partial<K extends Key<T>>(attrs: K[]): ExtendableSerializer<Require<T, K>> {
        return this.optional({
            required: attrs,
            optional: difference(keys(this.fields), attrs),
            defaults: {},
        }) as ExtendableSerializer<Require<T, K>>;
    }
    public fullPartial(): ExtendableSerializer<Partial<T>> {
        return this.optional({
            required: [],
            optional: keys(this.fields),
            defaults: {},
        });
    }
    public optional<R extends Key<T>, O extends Key<T>, D extends keyof T>(options: OptionalOptions<T, R, O, D>): ExtendableSerializer<OptionalInput<T, R, O, D>, OptionalOutput<T, R, O, D>> {
        return new OptionalSerializer(options, this.fields);
    }
    public defaults<D extends keyof T>(defaults: {[P in D]: T[P]}): DefaultsSerializer<T, D> {
        return new DefaultsSerializer(defaults, this.fields);
    }
    public extend<E>(fields: Fields<E>): FieldSerializer<T & E> {
        return new FieldSerializer({...this.fields, ...fields} as Fields<T & E>);
    }
}

export interface OptionalOptions<S, R extends keyof S, O extends keyof S, D extends keyof S> {
    required: R[];
    optional: O[];
    defaults: {[P in D]: S[P]};
}

export type OptionalInput<S, R extends keyof S, O extends keyof S, D extends keyof S> = Pick<S, R> & Partial<Pick<S, O | D>>;
export type OptionalOutput<S, R extends keyof S, O extends keyof S, D extends keyof S> = Pick<S, R | D> & Partial<Pick<S, O>>;

export class OptionalSerializer<S, R extends keyof S, O extends keyof S, D extends keyof S>
    extends BaseSerializer<OptionalInput<S, R, O, D>, OptionalOutput<S, R, O, D>>
    implements ExtendableSerializer<OptionalInput<S, R, O, D>, OptionalOutput<S, R, O, D>> {

    private readonly requiredFields: R[];
    private readonly optionalFields: Array<O | D>;
    private readonly defaults: {[P in D]: S[P]};

    constructor(private readonly options: OptionalOptions<S, R, O, D>, protected fields: Fields<S>) {
        super();
        const {required, optional, defaults} = options;
        this.requiredFields = required;
        this.optionalFields = [...optional, ...keys(defaults)];
        this.defaults = defaults;
    }

    public extend<E>(fields: Fields<E>): OptionalSerializer<S & E, R | keyof E, O, D> {
        const additionalKeys = keys(fields) as Array<keyof E>;
        const options = this.options;
        return new OptionalSerializer<S & E, R | keyof E, O, D>({
            required: [...options.required, ...additionalKeys] as Array<R | keyof E>,
            optional: options.optional,
            defaults: options.defaults as {[P in D]: (S & E)[P]},
        }, {...this.fields, ...fields} as Fields<S & E>);
    }

    protected transformFieldWith(field: Field<any>, value: any, key: any, callback: FieldConverter): any {
        const {requiredFields, optionalFields, defaults} = this;
        if (typeof value === 'undefined') {
            // Value is missing
            const defaultValue = defaults[key as D];
            if (typeof defaultValue !== 'undefined') {
                // Return the default value
                return defaultValue;
            }
            if (optionalFields.indexOf(key) >= 0) {
                // Allow this value to be undefined
                return value;
            }
        }
        // Otherwise deserialize normally if one of the allowed fields
        if (requiredFields.indexOf(key) >= 0 || optionalFields.indexOf(key) >= 0) {
            return super.transformFieldWith(field, value, key, callback);
        }
        // Otherwise this should be omitted
    }
}

export class DefaultsSerializer<S, D extends keyof S> extends BaseSerializer<Pick<S, Exclude<keyof S, D> & Partial<Pick<S, D>>>, S> {
    constructor(private readonly defaults: {[P in D]: S[P]}, protected fields: Fields<S>) {
        super();
    }

    protected transformFieldWith(field: Field<any>, value: any, key: any, callback: FieldConverter): any {
        if (typeof value === 'undefined') {
            // Value is missing
            const defaultValue = this.defaults[key as D];
            if (typeof defaultValue !== 'undefined') {
                // Return the default value
                return defaultValue;
            }
        }
        // Otherwise deserialize normally
        return super.transformFieldWith(field, value, key, callback);
    }
}

class NestedSerializerField<I> implements Field<I, Serialization> {
    // tslint:disable-next-line:no-shadowed-variable
    constructor(private serializer: Serializer<I, any>) {}
    public validate(value: I): I {
        return this.serializer.validate(value);
    }
    public serialize(value: I): Serialization {
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

export function nested<I>(res: Serializer<I, any>): Field<I, Encoding> {
    return new NestedSerializerField(res);
}

export function nestedList<I>(res: Serializer<I, any>): Field<I[], Encoding[]> {
    return list(nested(res));
}

export function serializer<T>(fields: Fields<T>): Serializer<T> {
    return new FieldSerializer<T>(fields);
}
