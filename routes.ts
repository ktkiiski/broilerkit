import { Fields, FieldSerializer, Serializer } from './serializers';
import { Url, UrlPattern } from './url';
import { Key } from './utils/objects';

export class Route<S, K extends Key<S> | never> {
    constructor(public readonly serializer: Serializer<S>, public readonly pattern: UrlPattern<K>) {}

    public match(url: string | Url): S | null {
        const urlMatch = this.pattern.match(url);
        return urlMatch && this.serializer.decode(urlMatch);
    }

    public compile(state: S) {
        return this.pattern.compile(this.serializer.encode(state));
    }
}

export function route<S = {}, K extends Key<S> = Key<S>>(pattern: UrlPattern<K>, serializer?: Serializer<S>): Route<S, K>;
export function route<S = {}, K extends Key<S> | never = Key<S>>(pattern: UrlPattern<K>, serializer: Serializer<S> = new FieldSerializer({} as Fields<S>)) {
    return new Route<S, K>(serializer, pattern);
}
