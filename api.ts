// tslint:disable:max-classes-per-file
// tslint:disable:no-shadowed-variable
import { concat, defer, merge, never, Observable } from 'rxjs';
import { filter, finalize, map, scan, shareReplay, startWith, switchMap, takeUntil } from 'rxjs/operators';
import { ajax } from './ajax';
import { toArray } from './async';
import { AuthClient } from './auth';
import { Client } from './client';
import { applyCollectionChange, isCollectionChange, ResourceChange } from './collections';
import { choice, Field, nullable, url } from './fields';
import { AuthenticatedHttpRequest, HttpHeaders, HttpMethod, HttpRequest, HttpStatus } from './http';
import { shareIterator } from './iteration';
import { observeIterable } from './observables';
import { EncodedResource, nestedList, Resource, resource, SerializedResource, Serializer } from './resources';
import { Route, route } from './routes';
import { pattern, Url } from './url';
import { Key, keys, spread, transformValues } from './utils/objects';

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

export interface IApiListPage<T> {
    next: string | null;
    results: T[];
}

export interface MethodHandlerRequest {
    urlParameters: {[key: string]: string};
    payload?: any;
}

export type ListParams<R, K extends keyof R> = {[P in K]: {ordering: P, direction: 'asc' | 'desc', since?: R[P]}}[K];

export interface RetrieveEndpoint<I, O, B extends undefined | keyof I> {
    get(query: I): Promise<O>;
    validateGet(query: I): I;
    observe(query: I): Observable<O>;
    observeWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<O | null>;
}

export interface ListEndpoint<I, O, B extends undefined | keyof I> {
    getPage(query: I): Promise<IApiListPage<O>>;
    getAll(query: I): Promise<O[]>;
    validateGet(query: I): I;
    observe(query: I): Observable<Observable<O>>;
    observeIterable(query: I): Observable<AsyncIterable<O>>;
    observeAll(query: I): Observable<O[]>;
    observeWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<Observable<O> | null>;
    observeAllWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<O[] | null>;
    observeIterableWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<AsyncIterable<O> | null>;
}

export interface CreateEndpoint<I1, I2, O> {
    post(input: I1): Promise<O>;
    validatePost(input: I1): I2;
}

export interface UpdateEndpoint<I1, I2, P, S> {
    put(input: I1): Promise<S>;
    patch(input: P): Promise<S>;
    validatePut(input: I1): I2;
    validatePatch(input: P): P;
}

export interface DestroyEndpoint<I> {
    delete(query: I): Promise<void>;
}

export interface EndpointDefinition<T, X extends EndpointMethodMapping> {
    methodHandlers: X;
    methods: HttpMethod[];
    route: Route<any, any> | Route<any, never>;
    userIdAttribute: string | undefined;
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
        protected idAttribute: string,
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

class RetrieveEndpointModel<I, O, B extends undefined | keyof I> extends ApiModel implements RetrieveEndpoint<I, O, B> {
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
            resource$ = concat(
                // Start with the retrieved state of the resource
                this.ajax('GET', url, payload),
                // Then emit all the updates to the resource
                update$,
            ).pipe(
                // Combine all the changes with the latest state to the resource.
                scan<Partial<O>, O>((res, update) => spread(res, update), {} as O),
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
    public observeWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<O | null> {
        return this.withUserId(query, (input: I) => this.observe(input));
    }
}

class ListEndpointModel<I extends ListParams<any, any>, O, B extends undefined | keyof I> extends ApiModel implements ListEndpoint<I, O, B> {
    private collectionCache?: Map<string, Observable<AsyncIterable<O>>>;
    public getPage(input: I): Promise<IApiListPage<O>> {
        const method = 'GET';
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        return this.ajax(method, url, payload);
    }
    public getAll(input: I): Promise<O[]> {
        const handlePage = async ({next, results}: IApiListPage<O>): Promise<O[]> => {
            if (!next) {
                return results;
            }
            const nextPage = await this.ajax('GET', next);
            return [...results, ...await handlePage(nextPage)];
        };
        return this.getPage(input).then(handlePage);
    }
    public getIterable(input: I): AsyncIterable<O> {
        return shareIterator(this.iterate(input));
    }
    public async *iterate(input: I) {
        let page = await this.getPage(input);
        while (true) {
            for (const item of page.results) {
                yield item;
            }
            if (page.next) {
                page = await this.ajax('GET', page.next);
            } else {
                break;
            }
        }
    }
    public validateGet(input: I): I {
        return this.validate('GET', input);
    }
    public observe(input: I): Observable<Observable<O>> {
        return this.observeIterable(input).pipe(map(observeIterable));
    }
    public observeIterable(input: I): Observable<AsyncIterable<O>> {
        const {url} = this.endpoint.serializeRequest('GET', input);
        const cacheKey = url.toString();
        const {direction, ordering} = input;
        const idAttribute = this.idAttribute as Key<O>;
        return defer(() => {
            // Use a cached observable, if available
            const collectionCache = this.collectionCache || new Map<string, Observable<AsyncIterable<O>>>();
            this.collectionCache = collectionCache;
            let collection$ = collectionCache.get(cacheKey);
            if (collection$) {
                return collection$;
            }
            const iterable = this.getIterable(input);
            const addition$ = this.client.resourceAddition$;
            const update$ = this.client.resourceUpdate$;
            const removal$ = this.client.resourceRemoval$;
            const change$ = merge(addition$, update$, removal$).pipe(
                filter((change) => isCollectionChange(url.path, change)),
            );
            collection$ = change$.pipe(
                // Combine all the changes with the latest state to the resource.
                scan<ResourceChange<O, keyof O>, AsyncIterable<O>>(
                    (collection, change) => applyCollectionChange(collection, change, idAttribute, ordering, direction),
                    iterable,
                ),
                // Always start with the initial state
                startWith(iterable),
                // Complete when the resource is removed
                takeUntil(removal$),
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
    public observeWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<Observable<O> | null> {
        return this.withUserId(query, (input: I) => this.observe(input));
    }
    public observeAllWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<O[] | null> {
        return this.withUserId(query, (input: I) => this.observeAll(input));
    }
    public observeIterableWithUser(query: Pick<I, Exclude<keyof I, B>>): Observable<AsyncIterable<O> | null> {
        return this.withUserId(query, (input: I) => this.observeIterable(input));
    }
}

class CreateEndpointModel<I1, I2, O> extends ApiModel implements CreateEndpoint<I1, I2, O> {
    public async post(input: I1): Promise<O> {
        const method = 'POST';
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        const resource = await this.ajax(method, url, payload);
        const resourceId = resource[this.idAttribute];
        this.client.resourceAddition$.next({
            type: 'addition',
            collectionUrl: url.path,
            resource,
            resourceId,
        });
        return resource;
    }
    public validatePost(input: I1): I2 {
        return this.validate('POST', input);
    }
}

class UpdateEndpointModel<I1, I2, P, S> extends ApiModel implements UpdateEndpoint<I1, I2, P, S> {
    public put(input: I1): Promise<S> {
        return this.update('PUT', input);
    }
    public validatePut(input: I1): I2 {
        return this.validate('PUT', input);
    }
    public patch(input: P): Promise<S> {
        return this.update('PATCH', input);
    }
    public validatePatch(input: P): P {
        return this.validate('PATCH', input);
    }
    private async update(method: 'PUT' | 'PATCH', input: I1 | P): Promise<S> {
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        const resource = await this.ajax(method, url, payload);
        const resourceId = resource[this.idAttribute];
        this.client.resourceUpdate$.next({
            type: 'update',
            resourceUrl: url.path,
            resource,
            resourceId,
        });
        return resource;
    }
}

class DestroyEndpointModel<I> extends ApiModel implements DestroyEndpoint<I> {
    public async delete(query: I): Promise<void> {
        const method = 'DELETE';
        const {url, payload} = this.endpoint.serializeRequest(method, query);
        await this.ajax(method, url, payload);
        const resourceId = query[this.idAttribute as keyof I];
        this.client.resourceRemoval$.next({
            type: 'removal',
            resourceUrl: url.path,
            resourceId,
        });
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

export type ListEndpointDefinition<S, U extends Key<S>, K extends Key<S>, A extends AuthenticationType, T, R extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, ListEndpoint<ListParams<S, K> & Pick<S, U>, S, B> & T, ListEndpointMethodMapping<A> & R, B>;
export type RetrieveEndpointDefinition<S, U extends Key<S>, A extends AuthenticationType, T, R extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, RetrieveEndpoint<Pick<S, U>, S, B> & T, RetrieveEndpointMethodMapping<A> & R, B>;
export type CreateEndpointDefinition<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, T, X extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, CreateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, S> & T, CreateEndpointMethodMapping<A> & X, B>;
export type UpdateEndpointDefinition<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, T, X extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, UpdateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, Pick<S, U> & Partial<Pick<S, R | O | D>>, S> & T, UpdateEndpointMethodMapping<A> & X, B>;
export type DestroyEndpointDefinition<S, U extends Key<S>, A extends AuthenticationType, T, R extends EndpointMethodMapping, B extends U | undefined> = ApiEndpoint<S, U, DestroyEndpoint<Pick<S, U>> & T, DestroyEndpointMethodMapping<A> & R, B>;

class ListParamSerializer<T, U extends Key<T>, K extends Key<T>> implements Serializer<Pick<T, U> & ListParams<T, K>> {
    private serializer = this.resource.pick(this.urlKeywords).extend({
        ordering: choice(this.orderingKeys),
        direction: choice(['asc', 'desc']),
    });
    constructor(private resource: Resource<T>, private urlKeywords: U[], private orderingKeys: K[]) {}

    public validate(input: Pick<T, U> & ListParams<T, K>): Pick<T, U> & ListParams<T, K> {
        const validated = this.serializer.validate(input);
        return this.extendSince(validated, input.since, (field, since) => field.validate(since));
    }
    public serialize(input: Pick<T, U> & ListParams<T, K>): SerializedResource {
        const serialized = this.serializer.serialize(input);
        return this.extendSince(serialized, input.since, (field, since) => field.serialize(since));
    }
    public deserialize(input: any): Pick<T, U> & ListParams<T, K> {
        const deserialized = this.serializer.deserialize(input);
        return this.extendSince(deserialized, input.since, (field, since) => field.deserialize(since));
    }
    public encode(input: Pick<T, U> & ListParams<T, K>): EncodedResource {
        const encoded = this.serializer.encode(input);
        return this.extendSince(encoded, input.since, (field, since) => field.encode(since));
    }
    public encodeSortable(input: Pick<T, U> & ListParams<T, K>): EncodedResource {
        const encoded = this.serializer.encode(input);
        return this.extendSince(encoded, input.since, (field, since) => field.encodeSortable(since));
    }
    public decode(input: EncodedResource): Pick<T, U> & ListParams<T, K> {
        const decoded = this.serializer.decode(input);
        return this.extendSince(decoded, input.since, (field, since) => field.decode(since));
    }
    private extendSince(data: any, since: any, serialize: (field: Field<T[K], any>, since: any) => any) {
        const orderingField = this.resource.fields[data.ordering as Key<T>] as Field<T[K], any>;
        if (since !== undefined) {
            return {...data, since: serialize(orderingField, since)};
        }
        return data;
    }
}

export class ApiEndpoint<S, U extends Key<S>, T, X extends EndpointMethodMapping, B extends U | undefined> implements EndpointDefinition<T, X> {

    public static create<S, U extends Key<S>>(resource: Resource<S>, idAttribute: Key<S>, route: Route<Pick<S, U>, U>) {
        return new ApiEndpoint(resource, idAttribute, route, undefined, ['OPTIONS'], {
            OPTIONS: {auth: 'none', route},
        });
    }

    private constructor(
        public readonly resource: Resource<S>,
        private readonly idAttribute: Key<S>,
        public readonly route: Route<Pick<S, U>, U>,
        public readonly userIdAttribute: B,
        public readonly methods: HttpMethod[],
        public readonly methodHandlers: X,
        private readonly modelPrototypes: ApiModel[] = [],
    ) {}

    public authorizeBy<K extends U>(userIdKey: K) {
        return new ApiEndpoint(this.resource, this.idAttribute, this.route, userIdKey, this.methods, this.methodHandlers, this.modelPrototypes);
    }

    public listable<K extends Key<S>, A extends AuthenticationType = 'none'>(options: {auth?: A, orderingKeys: K[]}): ListEndpointDefinition<S, U, K, A, T, X, B> {
        const {orderingKeys, auth = 'none' as A} = options;
        const urlSerializer = new ListParamSerializer(this.resource, this.route.pattern.pathKeywords as U[], orderingKeys);
        const pageResource = resource({
            next: nullable(url()),
            results: nestedList(this.resource),
        });
        return new ApiEndpoint(
            this.resource, this.idAttribute, this.route, this.userIdAttribute, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: {auth, route: route(this.route.pattern, urlSerializer), resourceSerializer: pageResource} as ReadMethodHandler<A>}),
            [...this.modelPrototypes, ListEndpointModel.prototype],
        );
    }

    public retrievable<A extends AuthenticationType = 'none'>(options?: {auth: A}): RetrieveEndpointDefinition<S, U, A, T, X, B> {
        const auth = options && options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, this.idAttribute, route, this.userIdAttribute, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: {auth, route, resourceSerializer: resource} as ReadMethodHandler<A>}),
            [...this.modelPrototypes, RetrieveEndpointModel.prototype],
        );
    }

    public creatable<R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType = 'none'>(options: {auth?: A, required: R[], optional: O[], defaults: {[P in D]: S[P]}}): CreateEndpointDefinition<S, U, R, O, D, A, T, X, B> {
        const payloadResource = this.resource.optional(options);
        const auth = options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, this.idAttribute, route, this.userIdAttribute, [...this.methods, 'POST'],
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
            resource, this.idAttribute, this.route, this.userIdAttribute, [...this.methods, 'PUT', 'PATCH'],
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
            resource, this.idAttribute, route, this.userIdAttribute, [...this.methods, 'DELETE'],
            spread(this.methodHandlers, {DELETE: {auth, route} as NoContentMethodHandler<A>}),
            [...this.modelPrototypes, DestroyEndpointModel.prototype],
        );
    }

    public bind(rootUrl: string, client: Client, authClient?: AuthClient): T {
        class BoundApiEndpoint extends ApiModel {}
        Object.assign(BoundApiEndpoint.prototype, ...this.modelPrototypes);
        return new BoundApiEndpoint(rootUrl, this.idAttribute, this.userIdAttribute, client, this, authClient) as any;
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

export function endpoint<R>(resource: Resource<R>, idAttribute: Key<R>) {
    function url<K extends Key<R> = never>(strings: TemplateStringsArray, ...keywords: K[]): ApiEndpoint<R, K, {}, OptionsEndpointMethodMapping, undefined> {
        return ApiEndpoint.create(resource, idAttribute, route(pattern(strings, ...keywords), resource.pick(keywords)));
    }
    return {url};
}

export type ApiEndpoints<T> = {[P in keyof T]: EndpointDefinition<T[P], EndpointMethodMapping>};

export function initApi<T>(rootUrl: string, endpoints: ApiEndpoints<T>, authClient?: AuthClient): T {
    const client = new Client();
    return transformValues(endpoints, (ep: EndpointDefinition<any, EndpointMethodMapping>) => ep.bind(rootUrl, client, authClient)) as any;
}
