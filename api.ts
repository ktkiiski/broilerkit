// tslint:disable:max-classes-per-file
// tslint:disable:no-shadowed-variable
import { concat, defer, merge, Observable, of } from 'rxjs';
import { combineLatest, concat as extend, distinctUntilChanged, filter, finalize, first, map, scan, shareReplay, startWith, switchMap, takeUntil } from 'rxjs/operators';
import { ajax } from './ajax';
import { filterAsync, toArray } from './async';
import { Client } from './client';
import { applyCollectionChange, ResourceAddition, ResourceChange, ResourceRemoval, ResourceUpdate } from './collections';
import { HttpMethod, SuccesfulResponse, Unauthorized } from './http';
import { shareIterator } from './iteration';
import { observeIterable } from './observables';
import { CreateOperation, DestroyOperation, ListOperation, Operation, RetrieveOperation, UpdateOperation } from './operations';
import { Cursor, Page } from './pagination';
import { OptionalInput, OptionalOutput } from './serializers';
import { Url } from './url';
import { hasProperties, isEqual } from './utils/compare';
import { Key, pick, spread } from './utils/objects';

export type Handler<I, O, D, R> = (input: I, db: D, request: R) => Promise<O>;
export type ResponseHandler<I, O, D, R> = Handler<I, SuccesfulResponse<O>, D, R>;

type UserInput<I, B> = Pick<I, Exclude<keyof I, B>>;

export interface IntermediateCollection<O> {
    isComplete: boolean;
    items: O[];
}

abstract class BaseApi<T extends Operation<any, any, any>> {
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

export class RetrieveEndpoint<S, U extends Key<S>, B extends U | undefined>
extends BaseApi<RetrieveOperation<S, U, any, B>> {
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
    public observeWithUser(query: Pick<S, Exclude<U, B>>): Observable<S | null> {
        return this.withUserId(query, (input: Pick<S, U>) => this.observe(input));
    }
}

export class ListApi<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B extends U | undefined>
extends BaseApi<ListOperation<S, U, O, F, any, B>> {
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

export class CreateApi<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, B extends U | undefined>
extends BaseApi<CreateOperation<S, U, R, O, D, any, B>> {
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
    public async postOptimistically(input: OptionalInput<S, U | R, O, D> & S): Promise<S> {
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
    public async postWithUserOptimistically(query: UserInput<OptionalInput<S, U | R, O, D> & S, B>): Promise<S> {
        const input = await this.extendUserId<OptionalInput<S, U | R, O, D> & S>(query);
        return await this.postOptimistically(input);
    }
    public validatePost(input: OptionalInput<S, U | R, O, D>): OptionalOutput<S, U | R, O, D> {
        const {route, payloadSerializer} = this.operation;
        return {
            ...route.serializer.validate(input),
            ...payloadSerializer.validate(input),
        } as OptionalOutput<S, U | R, O, D>;
    }
}

export class UpdateApi<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, B extends U | undefined>
extends BaseApi<UpdateOperation<S, U, R, O, D, any, B>> {
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
        } as OptionalInput<S, U, R | O, D>;
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

export class DestroyApi<S, U extends Key<S>, B extends U | undefined>
extends BaseApi<DestroyOperation<S, U, any, B>> {
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
}
