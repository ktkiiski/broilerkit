// tslint:disable:max-classes-per-file
// tslint:disable:no-shadowed-variable
import { concat, never, Observable, of } from 'rxjs';
import { ajax } from './ajax';
import { AuthClient } from './auth';
import { choice, Field, nullable, url } from './fields';
import { AuthenticatedHttpRequest, HttpHeaders, HttpMethod, HttpRequest, HttpStatus } from './http';
import { EncodedResource, nestedList, Resource, resource, SerializedResource, Serializer } from './resources';
import { Route, route } from './routes';
import { pattern, Url } from './url';
import { keys, spread, transformValues } from './utils/objects';

export { Field };

export interface AuthRequestMapping {
    none: HttpRequest;
    user: AuthenticatedHttpRequest;
    admin: AuthenticatedHttpRequest;
}

export type AuthenticationType = keyof AuthRequestMapping;

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

export interface RetrieveEndpoint<I, O> {
    get(query: I): Promise<O>;
    validateGet(query: I): I;
}

export interface ListEndpoint<I, O> {
    getPage(query: I): Promise<IApiListPage<O>>;
    getAll(query: I): Promise<O[]>;
    validateGet(query: I): I;
    observeAll(query: I): Observable<O[]>;
    observeCollection(query: I): Observable<Observable<O>>;
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
    route: Route<any, any>;
    bind(rootUrl: string, authClient?: AuthClient): T;
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
        private endpoint: EndpointDefinition<any, EndpointMethodMapping>,
        private authClient?: AuthClient,
    ) { }

    public request(method: HttpMethod, input: any): Promise<any> {
        const {url, payload} = this.endpoint.serializeRequest(method, input);
        return this.ajax(method, `${this.rootUrl}${url}`, payload);
    }

    public validate(method: HttpMethod, input: any): any {
        return this.endpoint.validate(method, input);
    }

    protected async ajax(method: HttpMethod, url: string, payload?: any) {
        const token = await this.getToken(method);
        const headers: {[header: string]: string} = token ? {Authorization: `Bearer ${token}`} : {};
        const response = await ajax({url, method, payload, headers});
        return this.endpoint.deserializeResponseData(method, response.data);
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

class RetrieveEndpointModel<I, O> extends ApiModel implements RetrieveEndpoint<I, O> {
    public get(input: I): Promise<O> {
        return this.request('GET', input);
    }
    public validateGet(input: I): I {
        return this.validate('GET', input);
    }
}

class ListEndpointModel<I, O> extends ApiModel implements ListEndpoint<I, O> {
    public getPage(input: I): Promise<IApiListPage<O>> {
        return this.request('GET', input);
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
    public validateGet(input: I): I {
        return this.validate('GET', input);
    }
    public observeAll(input: I): Observable<O[]> {
        return concat(this.getAll(input), never());
    }
    public observeCollection(input: I): Observable<Observable<O>> {
        return concat(of(new Observable<O>((subscriber) => {
            const handleError = (error?: any) => {
                subscriber.error(error);
            };
            const handlePage = ({next, results}: IApiListPage<O>): void => {
                for (const item of results) {
                    if (!subscriber.closed) {
                        subscriber.next(item);
                    }
                }
                if (next) {
                    if (!subscriber.closed) {
                        this.ajax('GET', next).then(handlePage, handleError);
                    }
                } else {
                    subscriber.complete();
                }
            };
            this.getPage(input).then(handlePage, handleError);
        })), never());
    }
}

class CreateEndpointModel<I1, I2, O> extends ApiModel implements CreateEndpoint<I1, I2, O> {
    public post(input: I1): Promise<O> {
        return this.request('POST', input);
    }
    public validatePost(input: I1): I2 {
        return this.validate('POST', input);
    }
}

class UpdateEndpointModel<I1, I2, P, S> extends ApiModel implements UpdateEndpoint<I1, I2, P, S> {
    public put(input: I1): Promise<S> {
        return this.request('PUT', input);
    }
    public validatePut(input: I1): I2 {
        return this.validate('PUT', input);
    }
    public patch(input: P): Promise<S> {
        return this.request('PATCH', input);
    }
    public validatePatch(input: P): P {
        return this.validate('PATCH', input);
    }
}

class DestroyEndpointModel<I> extends ApiModel implements DestroyEndpoint<I> {
    public delete(query: I): Promise<void> {
        return this.request('DELETE', query);
    }
}

export interface EndpointMethodHandler<A extends AuthenticationType = AuthenticationType> {
    auth: A;
    route: Route<any, any>;
    payloadSerializer?: Serializer;
    resourceSerializer?: Serializer;
}

export interface PayloadMethodHandler<A extends AuthenticationType> {
    auth: A;
    route: Route<any, any>;
    payloadSerializer: Serializer;
    resourceSerializer: Serializer;
}

export interface ReadMethodHandler<A extends AuthenticationType> {
    auth: A;
    route: Route<any, any>;
    resourceSerializer: Serializer;
}

export interface NoContentMethodHandler<A extends AuthenticationType> {
    auth: A;
    route: Route<any, any>;
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

export type ListEndpointDefinition<S, U extends keyof S, K extends keyof S, A extends AuthenticationType, T = {}, R extends EndpointMethodMapping = never> = ApiEndpoint<S, U, ListEndpoint<ListParams<S, K> & Pick<S, U>, S> & T, ListEndpointMethodMapping<A> & R>;
export type RetrieveEndpointDefinition<S, U extends keyof S, A extends AuthenticationType, T = {}, R extends EndpointMethodMapping = never> = ApiEndpoint<S, U, RetrieveEndpoint<Pick<S, U>, S> & T, RetrieveEndpointMethodMapping<A> & R>;
export type CreateEndpointDefinition<S, U extends keyof S, R extends keyof S, O extends keyof S, D extends keyof S, A extends AuthenticationType, T = {}, X extends EndpointMethodMapping = never> = ApiEndpoint<S, U, CreateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, S> & T, CreateEndpointMethodMapping<A> & X>;
export type UpdateEndpointDefinition<S, U extends keyof S, R extends keyof S, O extends keyof S, D extends keyof S, A extends AuthenticationType, T = {}, X extends EndpointMethodMapping = never> = ApiEndpoint<S, U, UpdateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, Pick<S, U> & Partial<Pick<S, R | O | D>>, S> & T, UpdateEndpointMethodMapping<A> & X>;
export type DestroyEndpointDefinition<S, U extends keyof S, A extends AuthenticationType, T = {}, R extends EndpointMethodMapping = never> = ApiEndpoint<S, U, DestroyEndpoint<Pick<S, U>> & T, DestroyEndpointMethodMapping<A> & R>;

class ListParamSerializer<T, U extends keyof T, K extends keyof T> implements Serializer<Pick<T, U> & ListParams<T, K>> {
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
        const orderingField = this.resource.fields[data.ordering as keyof T] as Field<T[K], any>;
        if (since !== undefined) {
            return {...data, since: serialize(orderingField, since)};
        }
        return data;
    }
}

export class ApiEndpoint<S, U extends keyof S, T, X extends EndpointMethodMapping> implements EndpointDefinition<T, X> {

    public static create<S, U extends keyof S>(resource: Resource<S>, route: Route<Pick<S, U>, U>) {
        return new ApiEndpoint(resource, route, ['OPTIONS'], {
            OPTIONS: {auth: 'none', route},
        });
    }

    private constructor(
        public readonly resource: Resource<S>,
        public readonly route: Route<Pick<S, U>, U>,
        public readonly methods: HttpMethod[],
        public readonly methodHandlers: X,
        private readonly modelPrototypes: ApiModel[] = [],
    ) {}

    public listable<K extends keyof S>(orderingKeys: K[]): ListEndpointDefinition<S, U, K, 'none', T, X>;
    public listable<K extends keyof S, A extends AuthenticationType>(options: {auth: A, orderingKeys: K[]}): ListEndpointDefinition<S, U, K, A, T, X>;
    public listable<K extends keyof S, A extends AuthenticationType = 'none'>(options: K[] | {auth?: A, orderingKeys: K[]}): ListEndpointDefinition<S, U, K, A, T, X> {
        const orderingKeys = Array.isArray(options) ? options : options.orderingKeys;
        const auth = !Array.isArray(options) && options.auth || 'none' as A;
        const urlSerializer = new ListParamSerializer(this.resource, this.route.pattern.pathKeywords as U[], orderingKeys);
        const pageResource = resource({
            next: nullable(url()),
            results: nestedList(this.resource),
        });
        return new ApiEndpoint(
            this.resource, this.route, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: {auth, route: route(this.route.pattern, urlSerializer), resourceSerializer: pageResource} as ReadMethodHandler<A>}),
            [...this.modelPrototypes, ListEndpointModel.prototype],
        );
    }

    public retrievable<A extends AuthenticationType = 'none'>(options?: {auth: A}): RetrieveEndpointDefinition<S, U, A, T, X> {
        const auth = options && options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, route, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: {auth, route, resourceSerializer: resource} as ReadMethodHandler<A>}),
            [...this.modelPrototypes, RetrieveEndpointModel.prototype],
        );
    }

    public creatable<R extends keyof S, O extends keyof S, D extends keyof S, A extends AuthenticationType = 'none'>(options: {auth?: A, required: R[], optional: O[], defaults: {[P in D]: S[P]}}): CreateEndpointDefinition<S, U, R, O, D, A, T, X> {
        const payloadResource = this.resource.optional(options);
        const auth = options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, route, [...this.methods, 'POST'],
            spread(this.methodHandlers, {POST: {auth, route, payloadSerializer: payloadResource, resourceSerializer: resource} as PayloadMethodHandler<A>}),
            [...this.modelPrototypes, CreateEndpointModel.prototype],
        );
    }

    public updateable<R extends keyof S, O extends keyof S, D extends keyof S, A extends AuthenticationType = 'none'>(options: {auth?: A, required: R[], optional: O[], defaults: {[P in D]: S[P]}}): UpdateEndpointDefinition<S, U, R, O, D, A, T, X> {
        const {required, optional, defaults} = options;
        const auth = options.auth || 'none' as A;
        const {resource, route} = this;
        const replaceResource = resource.optional(options);
        const updateResource = resource.pick([...required, ...optional, ...keys(defaults)]).partial();
        return new ApiEndpoint(
            resource, this.route, [...this.methods, 'PUT', 'PATCH'],
            spread(this.methodHandlers, {
                PUT: {auth, route, payloadSerializer: replaceResource, resourceSerializer: resource} as PayloadMethodHandler<A>,
                PATCH: {auth, route, payloadSerializer: updateResource, resourceSerializer: resource} as PayloadMethodHandler<A>,
            }),
            [...this.modelPrototypes, UpdateEndpointModel.prototype],
        );
    }

    public destroyable<A extends AuthenticationType = 'none'>(options?: {auth: A}): DestroyEndpointDefinition<S, U, A, T, X> {
        const auth = options && options.auth || 'none' as A;
        const {resource, route} = this;
        return new ApiEndpoint(
            resource, route, [...this.methods, 'DELETE'],
            spread(this.methodHandlers, {DELETE: {auth, route} as NoContentMethodHandler<A>}),
            [...this.modelPrototypes, DestroyEndpointModel.prototype],
        );
    }

    public bind(rootUrl: string, authClient?: AuthClient): T {
        class BoundApiEndpoint extends ApiModel {}
        Object.assign(BoundApiEndpoint.prototype, ...this.modelPrototypes);
        return new BoundApiEndpoint(rootUrl, this, authClient) as any;
    }

    public validate(method: HttpMethod, input: any): any {
        const handler = this.getMethodHandler(method);
        const {payloadSerializer, route} = handler;
        return {
            ...route.serializer.validate(input),
            ...payloadSerializer && payloadSerializer.validate(input),
        };
    }

    public serializeRequest(method: HttpMethod, input: any): ApiRequest {
        const handler = this.getMethodHandler(method);
        const url = handler.route.compile(input);
        const payload = handler.payloadSerializer && handler.payloadSerializer.serialize(input);
        return {method, url, payload};
    }

    public deserializeRequest(request: ApiRequest) {
        const {method, url, payload} = request;
        if (!this.hasMethod(method)) {
            // Non-supported HTTP method
            return null;
        }
        const handler = this.methodHandlers[method];
        const urlParameters = handler.route.match(url);
        if (!urlParameters) {
            // The path does not match this endpoint!
            return null;
        }
        const deserializedPayload = handler.payloadSerializer && handler.payloadSerializer.deserialize(payload);
        return {...urlParameters, ...deserializedPayload};
    }

    public serializeResponseData(method: HttpMethod, data: any) {
        const {resourceSerializer} = this.getMethodHandler(method);
        return resourceSerializer ? resourceSerializer.serialize(data) : undefined;
    }

    public deserializeResponseData(method: HttpMethod, data: any) {
        const {resourceSerializer} = this.getMethodHandler(method);
        return resourceSerializer ? resourceSerializer.deserialize(data) : undefined;
    }

    public getAuthenticationType(method: HttpMethod): AuthenticationType {
        return this.getMethodHandler(method).auth;
    }

    private getMethodHandler(method: HttpMethod): EndpointMethodHandler {
        if (!this.hasMethod(method)) {
            throw new Error(`Unsupported method ${method}`);
        }
        return this.methodHandlers[method];
    }

    private hasMethod(method: HttpMethod): method is keyof X & HttpMethod {
        return this.methodHandlers.hasOwnProperty(method);
    }
}

export function endpoint<R>(resource: Resource<R>) {
    function url<K extends keyof R = never>(strings: TemplateStringsArray, ...keywords: K[]): ApiEndpoint<R, K, {}, OptionsEndpointMethodMapping> {
        return ApiEndpoint.create(resource, route(pattern(strings, ...keywords), resource.pick(keywords)));
    }
    return {url};
}

export type ApiEndpoints<T> = {[P in keyof T]: EndpointDefinition<T[P], EndpointMethodMapping>};

export function initApi<T>(rootUrl: string, endpoints: ApiEndpoints<T>, authClient?: AuthClient): T {
    return transformValues(endpoints, (ep: EndpointDefinition<any, EndpointMethodMapping>) => ep.bind(rootUrl, authClient)) as T;
}
