import { Fields, FieldSerializer } from './serializers';

export class Resource<T> extends FieldSerializer<T> {
}

export type Deserialization<T extends Resource<any>> = T extends Resource<infer R> ? R : any;

export function resource<T>(fields: Fields<T>) {
    return new Resource<T>(fields);
}
