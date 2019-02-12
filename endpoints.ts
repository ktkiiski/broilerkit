import { nullable } from './fields';
import { Resource } from './resources';
import { Route } from './routes';
import { Fields, nested } from './serializers';
import { UrlPattern } from './url';
import { Key, Nullable, transformValues } from './utils/objects';

export class Endpoint<S, PK extends Key<S>, V extends Key<S> | undefined, U extends Key<S>> {
    constructor(
        public readonly resource: Resource<S, PK, V>,
        public readonly pattern: UrlPattern<U>,
    ) {}

    public join<E>(extension: {[P in keyof E]: Resource<E[P], any, any>}): Endpoint<S & Nullable<E>, PK, V, U> {
        const fields = transformValues(extension, (value) => nullable(nested(value)));
        const resource = this.resource.expand(fields as Fields<Nullable<E>>);
        return new Endpoint(resource, this.pattern);
    }

    public asRoute(): Route<Pick<S, U>, U> {
        const {pattern} = this;
        return new Route(this.resource.pick(pattern.pathKeywords), pattern);
    }
}

export function endpoint<S, PK extends Key<S>, V extends Key<S> | undefined, U extends Key<S>>(
    resource: Resource<S, PK, V>,
    pattern: UrlPattern<U>,
) {
    return new Endpoint<S, PK, V, U>(resource, pattern);
}
