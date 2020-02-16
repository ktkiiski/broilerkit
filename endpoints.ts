import { Key } from 'immuton/types';
import { Resource } from './resources';
import { Route } from './routes';
import { UrlPattern } from './url';

export class Endpoint<S, PK extends Key<S>, U extends Key<S>> {
    constructor(
        public readonly resource: Resource<S, PK>,
        public readonly pattern: UrlPattern<U>,
    ) {}

    public asRoute(): Route<Pick<S, U>, U> {
        const {pattern} = this;
        return new Route(this.resource.pick(pattern.pathKeywords), pattern);
    }
}

export function endpoint<S, PK extends Key<S>, U extends Key<S>>(
    resource: Resource<S, PK>,
    pattern: UrlPattern<U>,
) {
    return new Endpoint<S, PK, U>(resource, pattern);
}
