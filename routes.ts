import { resource, Serializer } from './resources';
import { Url, UrlPattern } from './url';

export class Route<S, K extends keyof S> {
    constructor(public readonly serializer: Serializer<S>, public readonly pattern: UrlPattern<K>) {}

    public match(url: string | Url): S | null {
        const urlMatch = this.pattern.match(url);
        return urlMatch && this.serializer.decode(urlMatch);
    }

    public compile(state: S) {
        return this.pattern.compile(this.serializer.encode(state));
    }
}

export function route(pattern: UrlPattern): Route<{}, never>;
export function route<S = {}, K extends keyof S = keyof S>(pattern: UrlPattern<K>, serializer?: Serializer<S>): Route<S, K>;
export function route<S = {}, K extends keyof S = keyof S>(pattern: UrlPattern<K>, serializer: Serializer<S> = resource({} as any)) {
    return new Route<S, K>(serializer, pattern);
}
