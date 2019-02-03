// tslint:disable:max-classes-per-file
// tslint:disable:no-shadowed-variable
import { concat, defer, from, merge, Observable, of, Subscribable } from 'rxjs';
import { combineLatest, concat as extend, distinctUntilChanged, filter, finalize, first, map, scan, shareReplay, startWith, switchMap, takeUntil } from 'rxjs/operators';
import { ajax } from './ajax';
import { filterAsync, toArray } from './async';
import { Bindable, BindableConnectable, Connectable } from './bindable';
import { Client } from './client';
import { applyCollectionChange, ResourceAddition, ResourceChange, ResourceRemoval, ResourceUpdate } from './collections';
import { Field, nullable } from './fields';
import { AuthenticatedHttpRequest, HttpMethod, HttpRequest, MethodNotAllowed, SuccesfulResponse, Unauthorized } from './http';
import { shareIterator } from './iteration';
import { observeIterable, observeValues } from './observables';
import { Cursor, CursorSerializer, Page, PageResponse } from './pagination';
import { Resource } from './resources';
import { Route, route } from './routes';
import { Fields, FieldSerializer, nested, nestedList, OptionalInput, OptionalOptions, OptionalOutput, Serializer } from './serializers';
import { Url, UrlPattern } from './url';
import { hasProperties, isEqual } from './utils/compare';
import { Key, keys, Nullable, pick, spread, transformValues } from './utils/objects';

export { Field };

export type Handler<I, O, D, A extends AuthenticationType> = (input: I, db: D, request: AuthRequestMapping[A]) => Promise<O>;
export type ResponseHandler<I, O, D, A extends AuthenticationType> = Handler<I, SuccesfulResponse<O>, D, A>;
export type MethodResponseHandlers<D, A extends AuthenticationType> = {
    [P in HttpMethod]?: ResponseHandler<any, any, D, A>
};

export interface Operation<I, O, A extends AuthenticationType> {
    type: 'retrieve' | 'update' | 'destroy' | 'list' | 'create';
    authType: A;
    urlPattern: UrlPattern;
    methods: HttpMethod[];
    route: Route<any, any>;
    userIdAttribute?: string;
    responseSerializer?: Serializer;
    deserializeRequest(request: HttpRequest): any;
    /**
     * This method only works as a hint to TypeScript to correctly
     * interprete operations as correct Implementable types.
     */
    asImplementable(): Operation<I, O, A>;
}

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

export interface RetrieveEndpoint<S, U extends Key<S>, B>
extends ObservableEndpoint<Pick<S, U>, S>, ObservableUserEndpoint<Pick<S, Exclude<U, B>>, S> {
    get(query: Pick<S, U>): Promise<S>;
    validateGet(query: Pick<S, U>): Pick<S, U>;
    observe(query: Pick<S, U>): Observable<S>;
    stream(query: ApiInput<Pick<S, U>>): Observable<S>;
}

export interface ListEndpoint<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B>
extends ObservableEndpoint<Cursor<S, U, O, F>, IntermediateCollection<S>>, ObservableUserEndpoint<UserInput<Cursor<S, U, O, F>, B>, IntermediateCollection<S>> {
    getPage(query: Cursor<S, U, O, F>): Promise<Page<S, Cursor<S, U, O, F>>>;
    getAll(query: Cursor<S, U, O, F>): Promise<S[]>;
    validateGet(query: Cursor<S, U, O, F>): Cursor<S, U, O, F>;
    observeObservable(query: Cursor<S, U, O, F>): Observable<Observable<S>>;
    observeIterable(query: Cursor<S, U, O, F>): Observable<AsyncIterable<S>>;
    observeAll(query: Cursor<S, U, O, F>, filters?: Partial<S>): Observable<S[]>;
    observeObservableWithUser(query: UserInput<Cursor<S, U, O, F>, B>): Observable<Observable<S> | null>;
    observeAllWithUser(query: UserInput<Cursor<S, U, O, F>, B>, filters?: Partial<S>): Observable<S[] | null>;
    observeIterableWithUser(query: UserInput<Cursor<S, U, O, F>, B>): Observable<AsyncIterable<S> | null>;
}

export interface CreateEndpoint<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, B>
extends Connectable<{}, CreateEndpoint<S, U, R, O, D, B>> {
    post(input: OptionalInput<S, U | R, O, D>): Promise<S>;
    postWithUser(input: OptionalInput<S, Exclude<U, B> | R, O, D>): Promise<S>;
    postOptimistically(input: OptionalInput<S, U | R, O, D> & O): Promise<S>;
    postWithUserOptimistically(input: UserInput<OptionalInput<S, U | R, O, D> & O, B>): Promise<S>;
    validatePost(input: OptionalInput<S, U | R, O, D>): OptionalOutput<S, U | R, O, D>;
}

export interface UpdateEndpoint<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, B>
extends Connectable<{}, UpdateEndpoint<S, U, R, O, D, B>> {
    put(input: OptionalInput<S, U | R, O, D>): Promise<S>;
    patch(input: OptionalInput<S, U, R | O, D>): Promise<S>;
    putWithUser(input: OptionalInput<S, Exclude<U, B> | R, O, D>): Promise<S>;
    validatePut(input: OptionalInput<S, U | R, O, D>): OptionalOutput<S, U | R, O, D>;
    patchWithUser(input: OptionalInput<S, Exclude<U, B>, R | O, D>): Promise<S>;
    validatePatch(input: OptionalInput<S, U, R | O, D>): OptionalInput<S, U, R | O, D>;
}

export interface DestroyEndpoint<S, U extends Key<S>, B>
extends Connectable<{}, DestroyEndpoint<S, U, B>> {
    delete(query: Pick<S, U>): Promise<void>;
    deleteWithUser(query: Pick<S, Exclude<U, B>>): Promise<void>;
}

abstract class ApiModel<T extends Operation<any, any, any>> {
    constructor(
        protected operation: T,
        protected client: Client,
    ) { }

    protected async ajax(method: HttpMethod, url: Url | string, payload?: any) {
        if (typeof url !== 'string') {
            url = `${this.client.rootUrl}${url}`;
        }
        const token = await this.getToken();
        const headers: {[header: string]: string} = token ? {Authorization: `Bearer ${token}`} : {};
        const response = await ajax({url, method, payload, headers});
        const {responseSerializer} = this.operation;
        return responseSerializer ? responseSerializer.deserialize(response.data) : undefined;
    }

    protected withUserId<I, T>(query: any, fn: (input: I) => Observable<T>): Observable<T | null> {
        const {userIdAttribute} = this.operation;
        const {authClient} = this.client;
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
        const {userIdAttribute} = this.operation;
        const {authClient} = this.client;
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

    private async getToken(): Promise<string | null> {
        const {authClient} = this.client;
        const {authType} = this.operation;
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

class RetrieveEndpointModel<S, U extends Key<S>, B extends U | undefined>
extends ApiModel<RetrieveOperation<S, U, any, B>>
implements RetrieveEndpoint<S, U, B> {
    public get(input: Pick<S, U>): Promise<S> {
        const url = this.operation.route.compile(input);
        return this.ajax('GET', url);
    }
    public validateGet(input: Pick<S, U>): Pick<S, U> {
        return this.operation.route.serializer.validate(input);
    }
    public observe(input: Pick<S, U>): Observable<S> {
        const resourceName = this.operation.endpoint.resource.name;
        const url = this.operation.route.compile(input);
        const cacheKey = url.toString();
        return defer(() => {
            // Use a cached observable, if available
            const {resourceCache} = this.client;
            let resource$: Observable<S> | undefined = resourceCache.get(cacheKey);
            if (resource$) {
                return resource$;
            }
            const update$ = this.client.resourceUpdate$.pipe(
                filter((update) => update.resourceName === resourceName),
                map((update) => update.resource as Partial<S>),
            );
            const removal$ = this.client.resourceRemoval$.pipe(
                filter((removal) => removal.resourceUrl === url.path),
            );
            const optimisticUpdates$ = this.client.optimisticUpdates$.pipe(
                map((updates) => updates.filter((update) => update.resourceName === resourceName)),
                distinctUntilChanged(isEqual),
            );
            resource$ = concat(
                // Start with the retrieved state of the resource
                this.ajax('GET', url),
                // Then emit all the updates to the resource
                update$,
            ).pipe(
                // Combine all the changes with the latest state to the resource.
                scan<Partial<S>, S>((res, update) => spread(res, update), {} as S),
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
    public observeSwitch(query$: Subscribable<Pick<S, U>>): Observable<S> {
        return from(query$).pipe(
            // Omit all the extra properties from the comparison
            map((query) => this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => this.observe(query)),
        );
    }
    public observeWithUser(query: Pick<S, Exclude<U, B>>): Observable<S | null> {
        return this.withUserId(query, (input: Pick<S, U>) => this.observe(input));
    }
    public observeWithUserSwitch(query$: Subscribable<Pick<S, Exclude<U, B>>>): Observable<S | null> {
        return from(query$).pipe(
            // TODO: This can be simplified (and optimized)
            switchMap((query) => this.withUserId(query, (r) => of(r as Pick<S, U>))),
            map((query) => query && this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => query ? this.observe(query) : of(null)),
        );
    }
    public stream(input$: ApiInput<Pick<S, U>>): Observable<S> {
        return observeValues(input$).pipe(
            distinctUntilChanged(isEqual),
            switchMap((input) => this.observe(input)),
        );
    }
}

class ListEndpointModel<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B extends U | undefined>
extends ApiModel<ListOperation<S, U, O, F, any, B>>
implements ListEndpoint<S, U, O, F, B> {
    public getPage(input: Cursor<S, U, O, F>): Promise<Page<S, Cursor<S, U, O, F>>> {
        const url = this.operation.route.compile(input);
        return this.ajax('GET', url);
    }
    public async getAll(input: Cursor<S, U, O, F>): Promise<S[]> {
        const results: S[] = [];
        for await (const pageResults of this.iteratePages(input)) {
            results.push(...pageResults);
        }
        return results;
    }
    public getIterable(input: Cursor<S, U, O, F>): AsyncIterable<S> {
        return shareIterator(this.iterate(input));
    }
    public async *iterate(input: Cursor<S, U, O, F>) {
        for await (const items of this.iteratePages(input)) {
            yield *items;
        }
    }
    public async *iteratePages(input: Cursor<S, U, O, F>) {
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
    public validateGet(input: Cursor<S, U, O, F>): Cursor<S, U, O, F> {
        return this.operation.route.serializer.validate(input);
    }
    public observe(input: Cursor<S, U, O, F>): Observable<IntermediateCollection<S>> {
        return this.observeObservable(input).pipe(
            switchMap((item$) => (
                item$.pipe(
                    scan((items: S[], item: S) => [...items, item], []),
                    startWith([] as S[]),
                    map((items) => ({items})),
                    extend(of({isComplete: true})),
                    scan<Partial<IntermediateCollection<S>>, IntermediateCollection<S>>((collection, change) => (
                        {...collection, ...change}), {isComplete: false, items: []},
                    ),
                )
            )),
        );
    }
    public observeSwitch(query$: Subscribable<Cursor<S, U, O, F>>): Observable<IntermediateCollection<S>> {
        return from(query$).pipe(
            // Omit all the extra properties from the comparison
            map((query) => this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => this.observe(query)),
        );
    }
    public observeObservable(input: Cursor<S, U, O, F>): Observable<Observable<S>> {
        return this.observeIterable(input).pipe(map(observeIterable));
    }
    public observeIterable(input: Cursor<S, U, O, F>): Observable<AsyncIterable<S>> {
        const {operation} = this;
        const url = operation.route.compile(input);
        const cacheKey = url.toString();
        const {direction, ordering} = input;
        const resourceName = operation.endpoint.resource.name;

        function isCollectionChange(change: ResourceChange<any, any>): boolean {
            if (change.type === 'addition') {
                return change.collectionUrl === url.path;
            }
            return change.resourceName === resourceName;
        }

        return defer(() => {
            const {client} = this;
            // Use a cached observable, if available
            const {collectionCache} = client;
            let collection$: Observable<AsyncIterable<S>> | undefined = collectionCache.get(cacheKey);
            if (collection$) {
                return collection$;
            }
            const iterable = this.getIterable(input);
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
                scan<ResourceChange<S, keyof S>, AsyncIterable<S>>(
                    (collection, change) => applyCollectionChange(collection, change, ordering, direction),
                    iterable,
                ),
                // Always start with the initial state
                startWith(iterable),
                // Apply optimistic changes
                combineLatest(optimisticChanges$, (collection, changes) => (
                    changes.reduce((result, change) => (
                        applyCollectionChange(result, change, ordering, direction)
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
    public observeAll(input: Cursor<S, U, O, F>, filters?: Partial<S>): Observable<S[]> {
        return this.observeIterable(input).pipe(
            switchMap((iterable) => toArray(
                !filters ? iterable : filterAsync(iterable, (item) => hasProperties(item, filters)),
            )),
        );
    }
    public observeWithUser(input: UserInput<Cursor<S, U, O, F>, B>): Observable<IntermediateCollection<S> | null> {
        return this.observeAllWithUser(input).pipe(
            map((items) => items && {isComplete: true, items}),
        );
    }
    public observeWithUserSwitch(query$: Subscribable<UserInput<Cursor<S, U, O, F>, B>>): Observable<IntermediateCollection<S> | null> {
        return from(query$).pipe(
            // TODO: This can be simplified (and optimized)
            switchMap((query) => this.withUserId(query, (r) => of(r as Cursor<S, U, O, F>))),
            map((query) => query && this.validateGet(query)),
            distinctUntilChanged(isEqual),
            switchMap((query) => query ? this.observe(query) : of(null)),
        );
    }
    public observeObservableWithUser(query: UserInput<Cursor<S, U, O, F>, B>): Observable<Observable<S> | null> {
        return this.withUserId(query, (input: Cursor<S, U, O, F>) => this.observeObservable(input));
    }
    public observeAllWithUser(query: UserInput<Cursor<S, U, O, F>, B>, filters?: Partial<S>): Observable<S[] | null> {
        return this.withUserId(query, (input: Cursor<S, U, O, F>) => this.observeAll(input, filters));
    }
    public observeIterableWithUser(query: UserInput<Cursor<S, U, O, F>, B>): Observable<AsyncIterable<S> | null> {
        return this.withUserId(query, (input: Cursor<S, U, O, F>) => this.observeIterable(input));
    }
}

class CreateEndpointModel<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, B extends U | undefined>
extends ApiModel<CreateOperation<S, U, R, O, D, any, B>>
implements CreateEndpoint<S, U, R, O, D, B> {
    public async post(input: OptionalInput<S, U | R, O, D>): Promise<S> {
        const method = 'POST';
        const {route, payloadSerializer} = this.operation;
        const {resource} = this.operation.endpoint;
        const url = route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const item = await this.ajax(method, url, payload);
        const resourceIdentity = pick(item, resource.identifyBy);
        const resourceName = resource.name;
        this.client.resourceAddition$.next({
            type: 'addition',
            collectionUrl: url.path,
            resourceName,
            resource: item,
            resourceIdentity,
        });
        return item;
    }
    public async postWithUser(query: OptionalInput<S, Exclude<U, B> | R, O, D>): Promise<S> {
        const input = await this.extendUserId<OptionalInput<S, U | R, O, D>>(query);
        return await this.post(input);
    }
    public async postOptimistically(input: OptionalInput<S, U | R, O, D> & O): Promise<S> {
        const {client, operation} = this;
        const {route, payloadSerializer} = operation;
        const {resource} = operation.endpoint;
        const method = 'POST';
        const url = route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const resource$ = this.ajax(method, url, payload);
        const resourceIdentity = pick(input as any, resource.identifyBy);
        const resourceName = resource.name;
        const addition: ResourceAddition<any, any> = {
            type: 'addition',
            collectionUrl: url.path,
            resource: input,
            resourceName,
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
                resourceName,
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
    public async postWithUserOptimistically(query: UserInput<OptionalInput<S, U | R, O, D> & O, B>): Promise<S> {
        const input = await this.extendUserId<OptionalInput<S, U | R, O, D> & O>(query);
        return await this.postOptimistically(input);
    }
    public validatePost(input: OptionalInput<S, U | R, O, D>): OptionalOutput<S, U | R, O, D> {
        const {route, payloadSerializer} = this.operation;
        return {
            ...route.serializer.validate(input),
            ...payloadSerializer.validate(input),
        } as OptionalOutput<S, U | R, O, D>;
    }
    public connect(): Observable<CreateEndpointModel<S, U, R, O, D, B>> {
        return of(this);
    }
}

class UpdateEndpointModel<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, B extends U | undefined>
extends ApiModel<UpdateOperation<S, U, R, O, D, any, B>>
implements UpdateEndpoint<S, U, R, O, D, B> {
    public put(input: OptionalInput<S, U | R, O, D>): Promise<S> {
        return this.update('PUT', input);
    }
    public async putWithUser(query: OptionalInput<S, Exclude<U, B> | R, O, D>): Promise<S> {
        const input = await this.extendUserId<OptionalInput<S, U | R, O, D>>(query);
        return await this.update('PUT', input);
    }
    public validatePut(input: OptionalInput<S, U | R, O, D>): OptionalOutput<S, U | R, O, D> {
        const {operation} = this;
        // TODO: Combine validation errors
        return {
            ...operation.route.serializer.validate(input),
            ...operation.replaceSerializer.validate(input),
        } as OptionalOutput<S, U | R, O, D>;
    }
    public patch(input: OptionalInput<S, U, R | O, D>): Promise<S> {
        return this.update('PATCH', input);
    }
    public async patchWithUser(query: OptionalInput<S, Exclude<U, B>, R | O, D>): Promise<S> {
        const input = await this.extendUserId<OptionalInput<S, U, R | O, D>>(query);
        return await this.update('PATCH', input);
    }
    public validatePatch(input: OptionalInput<S, U, R | O, D>): OptionalInput<S, U, R | O, D> {
        const {operation} = this;
        // TODO: Combine validation errors
        return {
            ...operation.route.serializer.validate(input),
            ...operation.updateSerializer.validate(input),
        } as OptionalOutput<S, U | R, O, D>;
    }
    public connect(): Observable<UpdateEndpoint<S, U, R, O, D, B>> {
        return of(this);
    }
    private async update(method: 'PUT' | 'PATCH', input: any): Promise<S> {
        const {client, operation} = this;
        const {resource} = operation.endpoint;
        const payloadSerializer = method === 'PATCH'
            ? operation.updateSerializer
            : operation.replaceSerializer
        ;
        const url = operation.route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const idAttributes = resource.identifyBy as Array<keyof any>;
        const resourceIdentity = pick(input, idAttributes);
        const resourceName = resource.name;
        const update: ResourceUpdate<any, any> = {
            type: 'update',
            resourceName,
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
                resourceName,
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

class DestroyEndpointModel<S, U extends Key<S>, B extends U | undefined>
extends ApiModel<DestroyOperation<S, U, any, B>>
implements DestroyEndpoint<S, U, B> {
    public async delete(query: Pick<S, U>): Promise<void> {
        const {client, operation} = this;
        const {resource} = operation.endpoint;
        const method = 'DELETE';
        const url = operation.route.compile(query);
        const idAttributes = resource.identifyBy as U[];
        const resourceIdentity = pick(query, idAttributes);
        const resourceName = resource.name;
        const removal: ResourceRemoval<any, any> = {
            type: 'removal',
            resourceUrl: url.path,
            resourceName,
            resourceIdentity,
        };
        const request = this.ajax(method, url);
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
    public async deleteWithUser(query: Pick<S, Exclude<U, B>>): Promise<void> {
        const input = await this.extendUserId<Pick<S, U>>(query);
        return await this.delete(input);
    }
    public connect(): Observable<DestroyEndpoint<S, U, B>> {
        return of(this);
    }
}

interface CommonEndpointOptions<A extends AuthenticationType, B extends undefined | keyof any> {
    auth?: A;
    authorizeBy?: B;
}

class Endpoint<S, PK extends Key<S>, V extends Key<S>, U extends Key<S>> {
    constructor(
        public readonly resource: Resource<S, PK, V>,
        public readonly pattern: UrlPattern<U>,
    ) {}

    public join<E>(extension: {[P in keyof E]: Resource<E[P], any, any>}): Endpoint<S & Nullable<E>, PK, V, U> {
        const fields = transformValues(extension, (value) => nullable(nested(value)));
        const resource = this.resource.expand(fields as Fields<Nullable<E>>);
        return new Endpoint(resource, this.pattern);
    }

    public listable<O extends Key<S>, F extends Key<S> = never, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
        options: CommonEndpointOptions<A, B> & {orderingKeys: O[], filteringKeys?: F[]},
    ): ListOperation<S, U, O, F, A, B> {
        return new ListOperation(
            this, options.orderingKeys, options.filteringKeys || [], options.auth || 'none' as A, options.authorizeBy as B,
        );
    }

    public creatable<R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
        options: CommonEndpointOptions<A, B> & OptionalOptions<S, R, O, D>,
    ): CreateOperation<S, U, R, O, D, A, B> {
        const {auth = 'none' as A, authorizeBy, ...opts} = options;
        return new CreateOperation(this, opts, auth, authorizeBy as B);
    }

    public retrievable<A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
        options?: CommonEndpointOptions<A, B>,
    ): RetrieveOperation<S, U, A, B> {
        const {auth = 'none' as A} = options || {};
        return new RetrieveOperation(this, auth, (options && options.authorizeBy) as B);
    }

    public updateable<R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
        options: CommonEndpointOptions<A, B> & OptionalOptions<S, R, O, D>,
    ): UpdateOperation<S, U, R, O, D, A, B> {
        const {auth = 'none' as A, authorizeBy, ...opts} = options;
        return new UpdateOperation(this, opts, auth, authorizeBy as B);
    }

    public destroyable<A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
        options?: CommonEndpointOptions<A, B>,
    ): DestroyOperation<S, U, A, B> {
        const {auth = 'none' as A} = options || {};
        return new DestroyOperation(this, auth, (options && options.authorizeBy) as B);
    }
}

abstract class BaseOperation<S, U extends Key<S>, I, O, A extends AuthenticationType, B extends U | undefined>
extends BindableConnectable<I, O> {
    public abstract readonly methods: HttpMethod[];
    public abstract readonly route: Route<any, U>;

    constructor(
        public readonly endpoint: Endpoint<S, any, any, U>,
        public readonly authType: A,
        public readonly userIdAttribute: B,
    ) {
        super();
    }

    protected deserializeRequest(request: HttpRequest): any | null {
        const url = new Url(request.path, request.queryParameters);
        // NOTE: Raises validation error if matches but invalid
        const urlParameters = this.route.match(url);
        if (!urlParameters) {
            // The URL path does not match this endpoint!
            return null;
        }
        if (this.methods.indexOf(request.method) < 0) {
            // URL matches but the method is not accepted
            throw new MethodNotAllowed(`Method ${request.method} is not allowed`);
        }
        return urlParameters;
    }
}

class ListOperation<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, Cursor<S, U, O, F>, IntermediateCollection<S>, A, B>
implements Operation<Cursor<S, U, O, F>, PageResponse<S, U, O, F>, A> {
    public readonly type: 'list' = 'list';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly urlPattern = this.endpoint.pattern;
    public readonly urlSerializer = new CursorSerializer(
        this.endpoint.resource,
        this.endpoint.pattern.pathKeywords,
        this.orderingKeys,
        this.filteringKeys,
    );
    public readonly route = route(this.endpoint.pattern, this.urlSerializer);
    public readonly responseSerializer = new FieldSerializer({
        next: nullable(nested(this.urlSerializer)),
        results: nestedList(this.endpoint.resource),
    });
    constructor(
        endpoint: Endpoint<S, any, any, U>,
        private readonly orderingKeys: O[],
        private readonly filteringKeys: F[],
        authType: A,
        userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public bind(client: Client): Connectable<Cursor<S, U, O, F>, IntermediateCollection<S>> {
        const model = new ListEndpointModel(this, client);
        return {
            connect: (props$) => (
                model.observeSwitch(props$).pipe(
                    startWith({items: [], isComplete: false}),
                )
            ),
        };
    }
    public all(): BindableConnectable<Cursor<S, U, O, F>, S[] | null> {
        return this.pipe(
            filter((collection) => collection.isComplete),
            map((collection) => collection.items),
            startWith(null),
        );
    }
    public deserializeRequest(request: HttpRequest): Cursor<S, U, O, F> | null {
        return super.deserializeRequest(request);
    }
    public asImplementable(): Operation<Cursor<S, U, O, F>, PageResponse<S, U, O, F>, A> {
        return this;
    }
}

class RetrieveOperation<S, U extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, Pick<S, U>, S | null, A, B>
implements Operation<Pick<S, U>, S, A> {
    public readonly type: 'retrieve' = 'retrieve';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly urlPattern = this.endpoint.pattern;
    public readonly route = route(this.urlPattern, this.endpoint.resource.pick(this.urlPattern.pathKeywords));
    public bind(client: Client): Connectable<Pick<S, U>, S | null> {
        const model = new RetrieveEndpointModel(this, client);
        return {
            connect: (props$) => (
                model.observeSwitch(props$).pipe(
                    startWith(null),
                )
            ),
        };
    }
    public deserializeRequest(request: HttpRequest): Pick<S, U> | null {
        return super.deserializeRequest(request);
    }
    public asImplementable(): Operation<Pick<S, U>, S, A> {
        return this;
    }
}

class CreateOperation<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, {}, CreateEndpoint<S, U, R, O, D, B>, A, B>
implements Operation<OptionalOutput<S, R, O, D>, SuccesfulResponse<S>, A>, Bindable<CreateEndpoint<S, U, R, O, D, B>> {
    public readonly type: 'create' = 'create';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly urlPattern = this.endpoint.pattern;
    public readonly route = route(this.urlPattern, this.endpoint.resource.pick(this.urlPattern.pathKeywords));
    public readonly payloadSerializer = this.endpoint.resource.optional(this.options);
    constructor(
        readonly endpoint: Endpoint<S, any, any, U>,
        private readonly options: OptionalOptions<S, R, O, D>,
        readonly authType: A,
        readonly userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public bind(client: Client): CreateEndpoint<S, U, R, O, D, B> {
        return new CreateEndpointModel(this, client);
    }
    public deserializeRequest(request: HttpRequest): OptionalOutput<S, R, O, D> | null {
        const urlParameters = super.deserializeRequest(request);
        // TODO: Combine validation errors
        return urlParameters && {
            ...urlParameters,
            ...this.payloadSerializer.deserialize(request.payload),
        };
    }
    public asImplementable(): Operation<Pick<S, R | U | D> & Partial<Pick<S, O>>, SuccesfulResponse<S>, A> {
        return this;
    }
}

class UpdateOperation<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, {}, UpdateEndpoint<S, U, R, O, D, B>, A, B>
implements Operation<OptionalOutput<S, R, O, D>, SuccesfulResponse<S>, A> {
    public readonly type: 'update' = 'update';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly urlPattern = this.endpoint.pattern;
    public readonly route = route(this.urlPattern, this.endpoint.resource.pick(this.urlPattern.pathKeywords));
    public readonly replaceSerializer = this.endpoint.resource.optional(this.options);
    public readonly updateSerializer = this.endpoint.resource
        .pick([...this.options.required, ...this.options.optional, ...keys(this.options.defaults)])
        .fullPartial()
    ;
    constructor(
        endpoint: Endpoint<S, any, any, any>,
        private readonly options: OptionalOptions<S, R, O, D>,
        authType: A,
        userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public bind(client: Client): UpdateEndpoint<S, U, R, O, D, B> {
        return new UpdateEndpointModel(this, client);
    }
    public deserializeRequest(request: HttpRequest): OptionalOutput<S, R, O, D> | Pick<S, U> & Partial<Pick<S, R | O | D>> | null {
        const payloadSerializer = request.method === 'PATCH'
            ? this.updateSerializer
            : this.replaceSerializer
        ;
        const urlParameters = super.deserializeRequest(request);
        // TODO: Combine validation errors
        return urlParameters && {
            ...urlParameters,
            ...payloadSerializer.deserialize(request.payload),
        };
    }
    public asImplementable(): Operation<Pick<S, R | U | D> & Partial<Pick<S, O>>, SuccesfulResponse<S>, A> {
        return this;
    }
}

class DestroyOperation<S, U extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, {}, DestroyEndpoint<S, U, B>, A, B>
implements Operation<Pick<S, U>, void, A> {
    public readonly type: 'destroy' = 'destroy';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly urlPattern = this.endpoint.pattern;
    public readonly route = route(this.urlPattern, this.endpoint.resource.pick(this.urlPattern.pathKeywords));
    public bind(client: Client): DestroyEndpoint<S, U, B> {
        return new DestroyEndpointModel(this, client);
    }
    public deserializeRequest(request: HttpRequest): Pick<S, U> | null {
        return super.deserializeRequest(request);
    }
    public asImplementable(): Operation<Pick<S, U>, void, A> {
        return this;
    }
}

export function endpoint<S, PK extends Key<S>, V extends Key<S>, U extends Key<S>>(
    resource: Resource<S, PK, V>,
    pattern: UrlPattern<U>,
) {
    return new Endpoint<S, PK, V, U>(resource, pattern);
}
