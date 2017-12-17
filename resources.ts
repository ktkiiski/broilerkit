import isPlainObject = require('lodash/isPlainObject');
import { Field, ValidationError } from './fields';

export interface FieldMapping {
    [name: string]: Field<any, any>;
}

export type InternalFieldSet<I> = {
    [P in keyof I]: Field<any, I[P]>;
};

export type ExternalFieldSet<E> = {
    [P in keyof E]: Field<E[P], any>;
};

export type ResourceFieldSet<E, I> = ExternalFieldSet<E> & InternalFieldSet<I>;

export class Serializer<E, I> implements Field<E, I> {
    constructor(public readonly fields: ResourceFieldSet<E, I>) {}

    public input(data: any): I {
        if (!isPlainObject(data)) {
            throw new ValidationError(`Value must be an object`);
        }
        const fields: FieldMapping = this.fields;
        // TODO: Collect validation errors!
        return mapValues(
            fields, (field, attr) => field.input(data[attr]),
        ) as I;
    }
    public inputAttribute<K extends keyof I>(data: Pick<I, K>, attr: K): I[K] {
        const fields: InternalFieldSet<I> = this.fields;
        return fields[attr].input(data[attr]);
    }
    public output(data: I): E {
        const fields: FieldMapping = this.fields;
        return mapValues(
            fields, (field, attr: keyof I) => field.output(data[attr]),
        ) as E;
    }
    public outputAttribute<K extends keyof E>(data: Pick<E, K>, attr: K): E[K] {
        const fields: ExternalFieldSet<E> = this.fields;
        return fields[attr].output(data[attr]);
    }
    public getField<K extends keyof E & keyof I>(attr: K): Field<E[K], I[K]> {
        return (this.fields as FieldMapping)[attr];
    }
    public encodeSortable(): never {
        throw new Error(`Serializer does not support string encoding`);
    }
    public decodeSortable(): never {
        throw new Error(`Serializer does not support string decoding`);
    }
}

export class ListSerializer<E, I> implements Field<E[], I[]> {
    private readonly serializer = new Serializer(this.fields);

    constructor(public readonly fields: ResourceFieldSet<E, I>) {}

    public input(data: any): I[] {
        // TODO: Ensure that array
        return (data as any[]).map((item) => this.serializer.input(item));
    }
    public output(data: I[]): E[] {
        return data.map((item) => this.serializer.output(item));
    }
    public encodeSortable(): never {
        throw new Error(`List serializer does not support string encoding`);
    }
    public decodeSortable(): never {
        throw new Error(`List serializer does not support string decoding`);
    }
}

export type EncodedResource<T> = {
    [P in keyof T]: string;
};

class SortableEncoderField<I> implements Field<string, I> {
    constructor(private field: Field<any, I>) {}

    public input(data: any): I {
        if (typeof data !== 'string') {
            throw new ValidationError(`Invalid string value`);
        }
        return this.decodeSortable(data);
    }
    public output(data: I): string {
        return this.encodeSortable(data);
    }
    public encodeSortable(value: I): string {
        return this.field.encodeSortable(value);
    }
    public decodeSortable(value: string): I {
        return this.field.decodeSortable(value);
    }
}

export class SortableEncoderSerializer<E, I> extends Serializer<EncodedResource<E & I>, I> {
    constructor(fields: ResourceFieldSet<E, I>) {
        super(mapValues(fields, (field) => new SortableEncoderField(field)) as ResourceFieldSet<EncodedResource<E & I>, I>);
    }
}

export function resource<E, I>(fields: ResourceFieldSet<E, I>): ResourceFieldSet<E, I> {
    return fields;
}

function mapValues<T, R, K extends keyof T>(obj: T, callback: (value: T[K], key: K) => R): {[P in keyof T]: R} {
    const result = {} as {[P in keyof T]: R};
    if (obj) {
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                result[key] = callback(obj[key], key as K);
            }
        }
    }
    return result;
}
