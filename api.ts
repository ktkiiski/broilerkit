// tslint:disable:max-classes-per-file
// tslint:disable:no-shadowed-variable
import { concat, defer, from, merge, never, Observable, of, Subscribable } from 'rxjs';
import { combineLatest, concat as extend, distinctUntilChanged, filter, finalize, first, map, scan, shareReplay, startWith, switchMap, takeUntil } from 'rxjs/operators';
import { ajax } from './ajax';
import { toArray } from './async';
import { AuthClient } from './auth';
import { Client } from './client';
import { applyCollectionChange, ResourceAddition, ResourceChange, ResourceRemoval, ResourceUpdate } from './collections';
import { Field, nullable } from './fields';
import { AuthenticatedHttpRequest, HttpHeaders, HttpMethod, HttpRequest, HttpStatus, SuccesfulResponse, Unauthorized } from './http';
import { shareIterator } from './iteration';
import { observeIterable, observeValues } from './observables';
import { Cursor, CursorSerializer, OrderedQuery, Page } from './pagination';
import { Resource, resource } from './resources';
import { Route, route } from './routes';
import { nested, nestedList, Serializer } from './serializers';
import { pattern, Url } from './url';
import { isEqual } from './utils/compare';
import { Key, keys, pick, spread, transformValues } from './utils/objects';

export { Field };

export interface AuthRequestMapping {
    none: HttpRequest;
    user: AuthenticatedHttpRequest;
    admin: AuthenticatedHttpRequest;
}

export type AuthenticationType = Key<AuthRequestMapping>;

export interface ApiRequest {
    method: HttpMethod;
    url: Url;
    payload?: any;
}

export interface ApiResponse {
    statusCode: HttpStatus;
    headers: HttpHeaders;
    data?: any;
}

export interface MethodHandlerRequest {
    urlParameters: {[key: string]: string};
    payload?: any;
}

export type ApiInput<I> = {[P in keyof I]: Subscribable<I[P]>};
export type UserInput<I, B> = Pick<I, Exclude<keyof I, B>>;

export interface IntermediateCollection<O> {
    isComplete: boolean;
    items: O[];
}

export interface ObservableEndpoint<I, O> {
    observe(query: I): Observable<O>;
    observeSwitch(query$: Subscribable<I>): Observable<O>;
}

export interface ObservableUserEndpoint<I, O> {
    observeWithUser(query: I): Observable<O | null>;
    observeWithUserSwitch(query$: Subscribable<I>): Observable<O | null>;
}

export interface RetrieveEndpoint<I, O, B> extends ObservableEndpoint<I, O>, ObservableUserEndpoint<UserInput<I, B>, O> {
    get(query: I): Promise<O>;
    validateGet(query: I): I;
    observe(query: I): Observable<O>;
    stream(query: ApiInput<I>): Observable<O>;
}

export interface ListEndpoint<I, O, B> extends ObservableEndpoint<I, IntermediateCollection<O>>, ObservableUserEndpoint<UserInput<I, B>, IntermediateCollection<O>> {
    getPage(query: I): Promise<Page<O, I>>;
    getAll(query: I): Promise<O[]>;
    validateGet(query: I): I;
    observeObservable(query: I): Observable<Observable<O>>;
    observeIterable(query: I): Observable<AsyncIterable<O>>;
    observeAll(query: I): Observable<O[]>;
    observeObservableWithUser(query: UserInput<I, B>): Observable<Observable<O> | null>;
    observeAllWithUser(query: UserInput<I, B>): Observable<O[] | null>;
    observeIterableWithUser(query: UserInput<I, B>): Observable<AsyncIterable<O> | null>;
}

export interface CreateEndpoint<I1, I2, O, B> {
    post(input: I1): Promise<O>;
    postWithUser(input: UserInput<I1, B>): Promise<O>;
    postOptimistically(input: I1 & O): Promise<O>;
    postWithUserOptimistically(input: UserInput<I1 & O, B>): Promise<O>;
    validatePost(input: I1): I2;
}

export interface UpdateEndpoint<I1, I2, P, S, B> {
    put(input: I1): Promise<S>;
    patch(input: P): Promise<S>;
    putWithUser(input: UserInput<I1, B>): Promise<S>;
    patchWithUser(input: UserInput<P, B>): Promise<S>;
    validatePut(input: I1): I2;
    validatePatch(input: P): P;
}

export interface DestroyEndpoint<I, B> {
    delete(query: I): Promise<void>;
    deleteWithUser(query: UserInput<I, B>): Promise<void>;
}

export interface EndpointDefinition<T, X extends EndpointMethodMapping> {
    methodHandlers: X;
    methods: HttpMethod[];
    route: Route<any, any> | Route<any, never>;
    userIdAttribute: string | undefined;
    parent: EndpointDefinition<any, any> | null;
    bind(rootUrl: string, client: Client, authClient?: AuthClient): T;
    validate(method: HttpMethod, input: any): any;
    serializeRequest(method: HttpMethod, input: any): ApiRequest;
    deserializeRequest(request: ApiRequest): any;
    serializeResponseData(method: HttpMethod, data: any): any;
    deserializeResponseData(method: HttpMethod, data: any): any;
    getAuthenticationType(method: HttpMethod): AuthenticationType;
}

class ApiModel {
    constructor(
        public rootUrl: string,
        protected idAttributes: string[],
        protected userIdAttribute: string | undefined,
        protected client: Client,
        protected endpoint: EndpointDefinition<any, EndpointMethodMapping>,
        protected authClient?: AuthClient,
    ) { }

    public validate(method: HttpMethod, input: any): any {
        return this.endpoint.validate(method, input);
    }

    protected async ajax(method: HttpMethod, url: Url | string, payload?: any) {
        if (typeof url !== 'string') {
            url = `${this.rootUrl}${url}`;
        }
        const token = await this.getToken(method);
        const headers: {[header: string]: string} = token ? {Authorization: `Bearer ${token}`} : {};
        const response = await ajax({url, method, payload, headers});
        return this.endpoint.deserializeResponseData(method, response.data);
    }

    protected withUserId<I, T>(query: any, fn: (input: I) => Observable<T>): Observable<T | null> {
        const {authClient, userIdAttribute} = this;
        if (!authClient) {
            throw new Error(`API endpoint requires authentication but no authentication client is defined.`);
        }
        if (!userIdAttribute) {
            throw new Error(`User ID attribute is undefined.`);
        }
        return authClient.observeUserId().pipe(
            switchMap((userId) => userId ? fn({...query, [userIdAttribute]: userId}) : [null]),
        );
    }

    protected extendUserId<I>(input: any): Promise<I> {
        const {authClient, userIdAttribute} = this;
        if (!authClient) {
            throw new Error(`API endpoint requires authentication but no authentication client is defined.`);
        }
        if (!userIdAttribute) {
            throw new Error(`User ID attribute is undefined.`);
        }
        return authClient.userId$.pipe(
            first(),
            map((value) => {
                if (!value) {
                    throw new Unauthorized(`Not authenticated`);
                }
                return {...input, [userIdAttribute]: value} as I;
            }),
        ).toPromise();
    }

    private async getToken(method: HttpMethod): Promise<string | null> {
        const {authClient} = this;
        const authType = this.endpoint.getAuthenticationType(method);
        if (authType === 'none') {
            // No authentication required, but return the token if available
            return authClient && authClient.getIdToken() || null;
        } else if (authClient) {
            // Authentication required, so demand a token
            return await authClient.demandIdToken();
        }
        // Authentication required but no auth client defined
        throw new Error(`API endpoint requires authentication but no authentication client is defined.`);
    }
}

class RetrieveEndpointModel<I, O, B> extends ApiModel implements RetrieveEndpoint<I, O, B> {
    private resourceCache?: Map<string, Observable<O>>;
    public get(input: I): Promise<O> {
        const method = 'GET';
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        return this.ajax(method, url, payload);
    }
    public validateGet(input: I): I {
        return this.validate('GET', input);
    }
    public observe(input: I): Observable<O> {
        const {url, payload} = this.endpoint.serializeRequest('GET', input);
        const cacheKey = url.toString();
        return defer(() => {
            // Use a cached observable, if available
            const resourceCache = this.resourceCache || new Map<string, Observable<O>>();
            this.resourceCache = resourceCache;
            let resource$ = resourceCache.get(cacheKey);
            if (resource$) {
                return resource$;
            }
            const update$ = this.client.resourceUpdate$.pipe(
                filter((update) => update.resourceUrl === url.path),
                map((update) => update.resource as Partial<O>),
            );
            const removal$ = this.client.resourceRemoval$.pipe(
                filter((removal) => removal.resourceUrl === url.path),
            );
            const optimisticUpdates$ = this.client.optimisticUpdates$.pipe(
                map((updates) => updates.filter((update) => update.resourceUrl === url.path)),
                distinctUntilChanged(isEqual),
            );
            resource$ = concat(
                // Start with the retrieved state of the resource
                this.ajax('GET', url, payload),
                // Then emit all the updates to the resource
                update$,
            ).pipe(
                // Combine all the changes with the latest state to the resource.
                scan<Partial<O>, O>((res, update) => spread(res, update), {} as O),
                // Apply any optimistic updates
                combineLatest(optimisticUpdates$, (res, updates) => (
                    updates.reduce((res, update) => spread(res, update.resource), res)
                )),
                // Complete when the resource is removed
                takeUntil(removal$),
                // When this Observable is unsubscribed, then remove from the cache.
                finalize(() => {
                    if (resourceCache.get(cacheKey) === resource$) {
                        resourceCache.delete(cacheKey);
                    }
                }),
                // Emit the latest state for all the new subscribers.
                shareReplay(1),
            );
            resourceCache.set(cacheKey, resource$);
            return resource$;
        });
    }
    public observeSwitch(query$: Subscribable<I>): Observable<O> {
        return from(query$).pipe(
            // Omit all the extra properties from the comparison
            map((query) => this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => this.observe(query)),
        );
    }
    public observeWithUser(query: UserInput<I, B>): Observable<O | null> {
        return this.withUserId(query, (input: I) => this.observe(input));
    }
    public observeWithUserSwitch(query$: Subscribable<UserInput<I, B>>): Observable<O | null> {
        return from(query$).pipe(
            // TODO: This can be simplified (and optimized)
            switchMap((query) => this.withUserId(query, (r) => of(r as I))),
            map((query) => query && this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => query ? this.observe(query) : of(null)),
        );
    }
    public stream(input$: ApiInput<I>): Observable<O> {
        return observeValues(input$).pipe(
            distinctUntilChanged(isEqual),
            switchMap((input) => this.observe(input)),
        );
    }
}

class ListEndpointModel<I extends OrderedQuery<any, any>, O, B> extends ApiModel implements ListEndpoint<I, O, B> {
    private collectionCache?: Map<string, Observable<AsyncIterable<O>>>;
    public getPage(input: I): Promise<Page<O, I>> {
        const method = 'GET';
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        return this.ajax(method, url, payload);
    }
    public async getAll(input: I): Promise<O[]> {
        const results: O[] = [];
        for await (const pageResults of this.iteratePages(input)) {
            results.push(...pageResults);
        }
        return results;
    }
    public getIterable(input: I): AsyncIterable<O> {
        return shareIterator(this.iterate(input));
    }
    public async *iterate(input: I) {
        for await (const items of this.iteratePages(input)) {
            yield *items;
        }
    }
    public async *iteratePages(input: I) {
        let page = await this.getPage(input);
        while (true) {
            yield page.results;
            if (page.next) {
                page = await this.getPage(page.next);
            } else {
                break;
            }
        }
    }
    public validateGet(input: I): I {
        return this.validate('GET', input);
    }
    public observe(input: I): Observable<IntermediateCollection<O>> {
        return this.observeObservable(input).pipe(
            switchMap((item$) => (
                item$.pipe(
                    scan((items: O[], item: O) => [...items, item], []),
                    startWith([] as O[]),
                    map((items) => ({items})),
                    extend(of({isComplete: true})),
                    scan<Partial<IntermediateCollection<O>>, IntermediateCollection<O>>((collection, change) => (
                        {...collection, ...change}), {isComplete: false, items: []},
                    ),
                )
            )),
        );
        return this.observeAll(input).pipe(
            map((items) => ({isComplete: true, items})),
        );
    }
    public observeSwitch(query$: Subscribable<I>): Observable<IntermediateCollection<O>> {
        return from(query$).pipe(
            // Omit all the extra properties from the comparison
            map((query) => this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => this.observe(query)),
        );
    }
    public observeObservable(input: I): Observable<Observable<O>> {
        return this.observeIterable(input).pipe(map(observeIterable));
    }
    public observeIterable(input: I): Observable<AsyncIterable<O>> {
        const {url} = this.endpoint.serializeRequest('GET', input);
        const cacheKey = url.toString();
        const {direction, ordering} = input;
        const idAttributes = this.idAttributes as Array<Key<O>>;

        function isCollectionChange(change: ResourceChange<any, any>): boolean {
            return change.collectionUrl === url.path;
        }

        return defer(() => {
            // Use a cached observable, if available
            const collectionCache = this.collectionCache || new Map<string, Observable<AsyncIterable<O>>>();
            this.collectionCache = collectionCache;
            let collection$ = collectionCache.get(cacheKey);
            if (collection$) {
                return collection$;
            }
            const iterable = this.getIterable(input);
            const {client} = this;
            const addition$ = client.resourceAddition$;
            const update$ = client.resourceUpdate$;
            const removal$ = client.resourceRemoval$;
            const change$ = merge(addition$, update$, removal$).pipe(
                filter(isCollectionChange),
            );
            const filterOptimisticChanges = map((changes: Array<ResourceChange<any, any>>) => changes.filter(isCollectionChange));
            const optimisticAdditions$ = client.optimisticAdditions$.pipe(filterOptimisticChanges);
            const optimisticRemovals$ = client.optimisticRemovals$.pipe(filterOptimisticChanges);
            const optimisticUpdates$ = client.optimisticUpdates$.pipe(filterOptimisticChanges);
            const optimisticChanges$ = optimisticAdditions$.pipe(
                combineLatest(
                    optimisticRemovals$, optimisticUpdates$,
                    (additions, removals, updates) => [...additions, ...removals, ...updates],
                ),
                distinctUntilChanged(isEqual),
            );
            collection$ = change$.pipe(
                // Combine all the changes with the latest state to the resource.
                scan<ResourceChange<O, keyof O>, AsyncIterable<O>>(
                    (collection, change) => applyCollectionChange(collection, change, idAttributes, ordering, direction),
                    iterable,
                ),
                // Always start with the initial state
                startWith(iterable),
                // Apply optimistic changes
                combineLatest(optimisticChanges$, (collection, changes) => (
                    changes.reduce((result, change) => (
                        applyCollectionChange(result, change, idAttributes, ordering, direction)
                    ), collection)
                )),
                // When this Observable is unsubscribed, then remove from the cache.
                finalize(() => {
                    if (collectionCache.get(cacheKey) === collection$) {
                        collectionCache.delete(cacheKey);
                    }
                }),
                // Emit the latest state for all the new subscribers.
                shareReplay(1),
            );
            collectionCache.set(cacheKey, collection$);
            return collection$;
        });
    }
    public observeAll(input: I): Observable<O[]> {
        return this.observeIterable(input).pipe(
            switchMap((iterable) => toArray(iterable)),
        );
        return concat(this.getAll(input), never());
    }
    public observeWithUser(input: UserInput<I, B>): Observable<IntermediateCollection<O> | null> {
        return this.observeAllWithUser(input).pipe(
            map((items) => items && {isComplete: true, items}),
        );
    }
    public observeWithUserSwitch(query$: Subscribable<UserInput<I, B>>): Observable<IntermediateCollection<O> | null> {
        return from(query$).pipe(
            // TODO: This can be simplified (and optimized)
            switchMap((query) => this.withUserId(query, (r) => of(r as I))),
            map((query) => query && this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => query ? this.observe(query) : of(null)),
        );
    }
    public observeObservableWithUser(query: UserInput<I, B>): Observable<Observable<O> | null> {
        return this.withUserId(query, (input: I) => this.observeObservable(input));
    }
    public observeAllWithUser(query: UserInput<I, B>): Observable<O[] | null> {
        return this.withUserId(query, (input: I) => this.observeAll(input));
    }
    public observeIterableWithUser(query: UserInput<I, B>): Observable<AsyncIterable<O> | null> {
        return this.withUserId(query, (input: I) => this.observeIterable(input));
    }
}

class CreateEndpointModel<I1, I2, O, B> extends ApiModel implements CreateEndpoint<I1, I2, O, B> {
    public async post(input: I1): Promise<O> {
        const method = 'POST';
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        const resource = await this.ajax(method, url, payload);
        const resourceIdentity = pick(resource, this.idAttributes);
        this.client.resourceAddition$.next({
            type: 'addition',
            collectionUrl: url.path,
            resource,
            resourceIdentity,
        });
        return resource;
    }
    public async postWithUser(query: UserInput<I1, B>): Promise<O> {
        const input = await this.extendUserId<I1>(query);
        return await this.post(input);
    }
    public async postOptimistically(input: I1 & O): Promise<O> {
        const {client} = this;
        const method = 'POST';
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        const resource$ = this.ajax(method, url, payload);
        const resourceIdentity = pick(input as any, this.idAttributes);
        const addition: ResourceAddition<any, any> = {
            type: 'addition',
            collectionUrl: url.path,
            resource: input,
            resourceIdentity,
        };
        try {
            client.optimisticAdditions$.next([
                ...client.optimisticAdditions$.getValue(),
                addition,
            ]);
            const resource = await resource$;
            client.resourceAddition$.next({
                type: 'addition',
                collectionUrl: url.path,
                resource,
                resourceIdentity,
            });
            return resource;
        } finally {
            client.optimisticAdditions$.next(
                client.optimisticAdditions$.getValue().filter(
                    (x) => x !== addition,
                ),
            );
        }
    }
    public async postWithUserOptimistically(query: UserInput<I1 & O, B>): Promise<O> {
        const input = await this.extendUserId<I1 & O>(query);
        return await this.postOptimistically(input);
    }
    public validatePost(input: I1): I2 {
        return this.validate('POST', input);
    }
}

class UpdateEndpointModel<I1, I2, P, S, B> extends ApiModel implements UpdateEndpoint<I1, I2, P, S, B> {
    public put(input: I1): Promise<S> {
        return this.update('PUT', input);
    }
    public async putWithUser(query: UserInput<I1, B>): Promise<S> {
        const input = await this.extendUserId<I1>(query);
        return await this.update('PUT', input);
    }
    public validatePut(input: I1): I2 {
        return this.validate('PUT', input);
    }
    public patch(input: P): Promise<S> {
        return this.update('PATCH', input);
    }
    public async patchWithUser(query: P): Promise<S> {
        const input = await this.extendUserId<P>(query);
        return await this.update('PATCH', input);
    }
    public validatePatch(input: P): P {
        return this.validate('PATCH', input);
    }
    private async update(method: 'PUT' | 'PATCH', input: I1 | P): Promise<S> {
        const {client} = this;
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        const idAttributes = this.idAttributes as Array<keyof (I1 | P)>;
        const resourceIdentity = pick(input, idAttributes);
        const parent = this.endpoint.parent;
        const parentUrl = parent && parent.route.compile(input);
        const collectionUrl = parentUrl ? parentUrl.path : undefined;
        const update: ResourceUpdate<any, any> = {
            type: 'update',
            collectionUrl,
            resourceUrl: url.path,
            resource: input,
            resourceIdentity,
        };
        const request = this.ajax(method, url, payload);
        try {
            client.optimisticUpdates$.next([
                ...client.optimisticUpdates$.getValue(),
                update,
            ]);
            const resource = await request;
            client.resourceUpdate$.next({
                type: 'update',
                collectionUrl,
                resourceUrl: url.path,
                resource,
                resourceIdentity,
            });
            return resource;
        } finally {
            client.optimisticUpdates$.next(
                client.optimisticUpdates$.getValue().filter(
                    (x) => x !== update,
                ),
            );
        }
    }
}

class DestroyEndpointModel<I, B> extends ApiModel implements DestroyEndpoint<I, B> {
    public async delete(query: I): Promise<void> {
        const {client} = this;
        const method = 'DELETE';
        const {url, payload} = this.endpoint.serializeRequest(method, query);
        const parent = this.endpoint.parent;
        const parentUrl = parent && parent.route.compile(query);
        const collectionUrl = parentUrl ? parentUrl.path : undefined;
        const idAttributes = this.idAttributes as Array<keyof I>;
        const resourceIdentity = pick(query, idAttributes);
        const removal: ResourceRemoval<any, any> = {
            type: 'removal',
            collectionUrl,
            resourceUrl: url.path,
            resourceIdentity,
        };
        const request = this.ajax(method, url, payload);
        try {
            client.optimisticRemovals$.next([
                ...client.optimisticRemovals$.getValue(),
                removal,
            ]);
            await request;
            client.resourceRemoval$.next(removal);
        } finally {
            client.optimisticRemovals$.next(
                client.optimisticRemovals$.getValue().filter(
                    (x) => x !== removal,
                ),
            );
        }
    }
    public async deleteWithUser(query: UserInput<I, B>): Promise<void> {
        const input = await this.extendUserId<I>(query);
        return await this.delete(input);
    }
}

export interface EndpointMethodHandler<A extends AuthenticationType = AuthenticationType> {
    auth: A;
    route: Route<any, any> | Route<any, never>;
    payloadSerializer?: Serializer;
    resourceSerializer?: Serializer;
}

export interface PayloadMethodHandler<A extends AuthenticationType> {
    auth: A;
    route: Route<any, any> | Route<any, never>;
    payloadSerializer: Serializer;
    resourceSerializer: Serializer;
}

export interface ReadMethodHandler<A extends AuthenticationType> {
    auth: A;
    route: Route<any, any> | Route<any, never>;
    resourceSerializer: Serializer;
}

export interface NoContentMethodHandler<A extends AuthenticationType> {
    auth: A;
    route: Route<any, any> | Route<any, never>;
}

export interface OptionsEndpointMethodMapping {
    OPTIONS: NoContentMethodHandler<'none'>;
}
export interface RetrieveEndpointMethodMapping<A extends AuthenticationType = AuthenticationType> {
    GET: ReadMethodHandler<A>;
}
export interface ListEndpointMethodMapping<A extends AuthenticationType = AuthenticationType> {
    GET: ReadMethodHandler<A>;
}
export interface CreateEndpointMethodMapping<A extends AuthenticationType = AuthenticationType> {
    POST: PayloadMethodHandler<A>;
}
export interface UpdateEndpointMethodMapping<A extends AuthenticationType = AuthenticationType> {
    PUT: PayloadMethodHandler<A>;
    PATCH: PayloadMethodHandler<A>;
}
export interface DestroyEndpointMethodMapping<A extends AuthenticationType = AuthenticationType> {
    DELETE: NoContentMethodHandler<A>;
}
export type EndpointMethodMapping = OptionsEndpointMethodMapping | RetrieveEndpointMethodMapping | ListEndpointMethodMapping | CreateEndpointMethodMapping | UpdateEndpointMethodMapping | DestroyEndpointMethodMapping;

export type ListEndpointDefinition<S, U extends Key<S>, K extends Key<S>, A extends AuthenticationType, T, R extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, ListEndpoint<Cursor<S, U, K>, S, B> & T, ListEndpointMethodMapping<A> & R, B>;
export type RetrieveEndpointDefinition<S, U extends Key<S>, A extends AuthenticationType, T, R extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, RetrieveEndpoint<Pick<S, U>, S, B> & T, RetrieveEndpointMethodMapping<A> & R, B>;
export type CreateEndpointDefinition<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, T, X extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, CreateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, S, B> & T, CreateEndpointMethodMapping<A> & X, B>;
export type UpdateEndpointDefinition<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, T, X extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, UpdateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, Pick<S, U> & Partial<Pick<S, R | O | D>>, S, B> & T, UpdateEndpointMethodMapping<A> & X, B>;
export type DestroyEndpointDefinition<S, U extends Key<S>, A extends AuthenticationType, T, R extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, DestroyEndpoint<Pick<S, U>, B> & T, DestroyEndpointMethodMapping<A> & R, B>;

export class ApiEndpoint<S, U extends Key<S>, T, X extends EndpointMethodMapping, B extends U | undefined> implements EndpointDefinition<T, X> {

    public static create<S, U extends Key<S>>(resource: Resource<S>, idAttributes: Array<Key<S>>, route: Route<Pick<S, U>, U>) {
        return new ApiEndpoint(resource, idAttributes, route, undefined, null, ['OPTIONS'], {
            OPTIONS: {auth: 'none', route},
        });
    }

    private constructor(
        public readonly resource: Resource<S>,
        private readonly idAttributes: Array<Key<S>>,
        public readonly route: Route<Pick<S, U>, U>,
        public readonly userIdAttribute: B,
        public readonly parent: ApiEndpoint<S, any, any, any, any> | null,
        public readonly methods: HttpMethod[],
        public readonly methodHandlers: X,
        private readonly modelPrototypes: ApiModel[] = [],
    ) {}

    public singleton() {
        const parent = this;
        function url<K extends Key<S> = never>(strings: TemplateStringsArray, ...keywords: K[]): ApiEndpoint<S, K, {}, OptionsEndpointMethodMapping, undefined> {
            const {resource, idAttributes} = parent;
            const r = route(pattern(strings, ...keywords), resource.pick(keywords));
            return new ApiEndpoint(resource, idAttributes, r, undefined, parent, ['OPTIONS'], {
                OPTIONS: {auth: 'none', route: r},
            });
        }
        return {url};
    }

    public authorizeBy<K extends U>(userIdKey: K): ApiEndpoint<S, U, T, X, K> {
        return new ApiEndpoint(this.resource, this.idAttributes, this.route, userIdKey, this.parent, this.methods, this.methodHandlers, this.modelPrototypes);
    }

    public listable<K extends Key<S>, A extends AuthenticationType = 'none'>(options: {auth?: A, orderingKeys: K[]}): ListEndpointDefinition<S, U, K, A, T, X, B> {
        const {orderingKeys, auth = 'none' as A} = options;
        const urlSerializer = new CursorSerializer(this.resource, this.route.pattern.pathKeywords as U[], orderingKeys);
        const pageResource = resource({
            next: nullable(nested(urlSerializer)),
            results: nestedList(this.resource),
        });
        return new ApiEndpoint(
            this.resource, this.idAttributes, this.route, this.userIdAttribute, this.parent, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: {auth, route: route(this.route.pattern, urlSerializer), resourceSerializer: pageResource} as ReadMethodHandler<A>}),
            [...this.modelPrototypes, ListEndpointModel.prototype],
        );
    }

    public retrievable<A extends AuthenticationType = 'none'>(options?: {auth: A}): RetrieveEndpointDefinition<S, U, A, T, X, B> {
        const auth = options && options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, this.idAttributes, route, this.userIdAttribute, this.parent, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: {auth, route, resourceSerializer: resource} as ReadMethodHandler<A>}),
            [...this.modelPrototypes, RetrieveEndpointModel.prototype],
        );
    }

    public creatable<R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType = 'none'>(options: {auth?: A, required: R[], optional: O[], defaults: {[P in D]: S[P]}}): CreateEndpointDefinition<S, U, R, O, D, A, T, X, B> {
        const payloadResource = this.resource.optional(options);
        const auth = options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, this.idAttributes, route, this.userIdAttribute, this.parent, [...this.methods, 'POST'],
            spread(this.methodHandlers, {POST: {auth, route, payloadSerializer: payloadResource, resourceSerializer: resource} as PayloadMethodHandler<A>}),
            [...this.modelPrototypes, CreateEndpointModel.prototype],
        );
    }

    public updateable<R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType = 'none'>(options: {auth?: A, required: R[], optional: O[], defaults: {[P in D]: S[P]}}): UpdateEndpointDefinition<S, U, R, O, D, A, T, X, B> {
        const {required, optional, defaults} = options;
        const auth = options.auth || 'none' as A;
        const {resource, route} = this;
        const replaceResource = resource.optional(options);
        const updateResource = resource.pick([...required, ...optional, ...keys(defaults)]).fullPartial();
        return new ApiEndpoint(
            resource, this.idAttributes, this.route, this.userIdAttribute, this.parent, [...this.methods, 'PUT', 'PATCH'],
            spread(this.methodHandlers, {
                PUT: {auth, route, payloadSerializer: replaceResource, resourceSerializer: resource} as PayloadMethodHandler<A>,
                PATCH: {auth, route, payloadSerializer: updateResource, resourceSerializer: resource} as PayloadMethodHandler<A>,
            }),
            [...this.modelPrototypes, UpdateEndpointModel.prototype],
        );
    }

    public destroyable<A extends AuthenticationType = 'none'>(options?: {auth: A}): DestroyEndpointDefinition<S, U, A, T, X, B> {
        const auth = options && options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, this.idAttributes, route, this.userIdAttribute, this.parent, [...this.methods, 'DELETE'],
            spread(this.methodHandlers, {DELETE: {auth, route} as NoContentMethodHandler<A>}),
            [...this.modelPrototypes, DestroyEndpointModel.prototype],
        );
    }

    public bind(rootUrl: string, client: Client, authClient?: AuthClient): T {
        class BoundApiEndpoint extends ApiModel {}
        Object.assign(BoundApiEndpoint.prototype, ...this.modelPrototypes);
        return new BoundApiEndpoint(rootUrl, this.idAttributes, this.userIdAttribute, client, this, authClient) as any;
    }

    public validate(method: HttpMethod, input: any): any {
        const handler = this.requireMethodHandler(method);
        const {payloadSerializer, route} = handler;
        return {
            ...route.serializer.validate(input),
            ...payloadSerializer && payloadSerializer.validate(input),
        };
    }

    public serializeRequest(method: HttpMethod, input: any): ApiRequest {
        const handler = this.requireMethodHandler(method);
        const url = handler.route.compile(input);
        const payload = handler.payloadSerializer && handler.payloadSerializer.serialize(input);
        return {method, url, payload};
    }

    public deserializeRequest(request: ApiRequest) {
        const {method, url, payload} = request;
        const handler = this.getMethodHandler(method);
        if (!handler) {
            // Non-supported HTTP method
            return null;
        }
        const urlParameters = handler.route.match(url);
        if (!urlParameters) {
            // The path does not match this endpoint!
            return null;
        }
        const deserializedPayload = handler.payloadSerializer && handler.payloadSerializer.deserialize(payload);
        return {...urlParameters, ...deserializedPayload};
    }

    public serializeResponseData(method: HttpMethod, data: any) {
        const {resourceSerializer} = this.requireMethodHandler(method);
        return resourceSerializer ? resourceSerializer.serialize(data) : undefined;
    }

    public deserializeResponseData(method: HttpMethod, data: any) {
        const {resourceSerializer} = this.requireMethodHandler(method);
        return resourceSerializer ? resourceSerializer.deserialize(data) : undefined;
    }

    public getAuthenticationType(method: HttpMethod): AuthenticationType {
        return this.requireMethodHandler(method).auth;
    }

    private requireMethodHandler(method: HttpMethod): EndpointMethodHandler {
        const handler = this.getMethodHandler(method);
        if (!handler) {
            throw new Error(`Unsupported method ${method}`);
        }
        return handler;
    }

    private getMethodHandler(method: HttpMethod): EndpointMethodHandler | null {
        return this.methodHandlers[method as keyof X] as any || null;
    }
}

export function endpoint<R>(resource: Resource<R>, ...idAttributes: Array<Key<R>>) {
    function url<K extends Key<R> = never>(strings: TemplateStringsArray, ...keywords: K[]): ApiEndpoint<R, K, {}, OptionsEndpointMethodMapping, undefined> {
        return ApiEndpoint.create(resource, idAttributes, route(pattern(strings, ...keywords), resource.pick(keywords)));
    }
    return {url};
}

export type ApiEndpoints<T> = {[P in keyof T]: EndpointDefinition<T[P], EndpointMethodMapping>};

export function initApi<T>(rootUrl: string, endpoints: ApiEndpoints<T>, authClient?: AuthClient): T {
    const client = new Client();
    return transformValues(endpoints, (ep: EndpointDefinition<any, EndpointMethodMapping>) => ep.bind(rootUrl, client, authClient)) as any;
}
