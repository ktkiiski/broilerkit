import { Field } from './fields';

export type InternalFieldSet<I> = {
    [P in keyof I]: Field<any, I[P]>;
};

export type ExternalFieldSet<E> = {
    [P in keyof E]: Field<E[P], any>;
};

export type ResourceFieldSet<E, I> = ExternalFieldSet<E> & InternalFieldSet<I>;

export class Serializer<E, I, R extends ResourceFieldSet<E, I>> implements Field<E, I> {
    constructor(public readonly fields: R) {}

    public input(data: any): I {
        return data as I; // TODO
    }

    public output(data: I): E {
        return data as any as E; // TODO
    }
}

export class ListSerializer<E, I, R extends ResourceFieldSet<E, I>, S extends Serializer<E, I, R>> implements Field<E[], I[]> {
    constructor(public readonly serializer: Serializer<E, I, ResourceFieldSet<E, I>> & S) {}

    public input(data: any): I[] {
        // TODO: Ensure that array
        return (data as any[]).map((item) => this.serializer.input(item));
    }

    public output(data: I[]): E[] {
        return data.map((item) => this.serializer.output(item));
    }
}

export function resource<E, I>(fields: ResourceFieldSet<E, I>): ResourceFieldSet<E, I> {
    return fields;
}
