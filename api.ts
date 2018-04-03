// tslint:disable:max-classes-per-file
// tslint:disable:no-shadowed-variable
import { ajax } from './ajax';
import { choice, Field, nullable, url } from './fields';
import { AuthenticatedHttpRequest, HttpHeaders, HttpMethod, HttpRequest, HttpStatus } from './http';
import { EncodedResource, nestedList, Resource, resource, SerializedResource, Serializer } from './resources';
import { compileUrl, makeUrlRegexp } from './url';
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
    path: string;
    queryParameters: {[key: string]: string};
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

function buildUrl(strings: TemplateStringsArray, keywords: string[]): string {
    const components: string[] = [];
    for (let i = 0; i < strings.length; i ++) {
        components.push(strings[i]);
        if (i < keywords.length) {
            components.push(`{${keywords[i]}}`);
        }
    }
    return components.join('');
}

export interface RetrieveEndpoint<I, O> {
    get(query: I): Promise<O>;
    validateGet(query: I): I;
}

export interface ListEndpoint<I, O> {
    getPage(query: I): Promise<IApiListPage<O>>;
    getAll(query: I): Promise<O[]>;
    validateGet(query: I): I;
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
    pathPattern: string;
    bind(rootUrl: string): T;
    validate(method: HttpMethod, input: any): any;
    serializeRequest(method: HttpMethod, input: any): ApiRequest;
    deserializeRequest(request: ApiRequest): any;
    serializeResponseData(method: HttpMethod, data: any): any;
    deserializeResponseData(method: HttpMethod, data: any): any;
}

class ApiModel {
    constructor(
        public rootUrl: string,
        private endpoint: EndpointDefinition<any, EndpointMethodMapping>,
    ) { }

    public async request(method: HttpMethod, input: any): Promise<any> {
        const {endpoint} = this;
        const {path, queryParameters, payload} = endpoint.serializeRequest(method, input);
        const url = compileUrl(this.rootUrl, path, queryParameters);
        const response = await ajax({url, method, payload});
        return endpoint.deserializeResponseData(method, response.data);
    }

    public validate(method: HttpMethod, input: any): any {
        return this.endpoint.validate(method, input);
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
        async function handlePage({next, results}: IApiListPage<O>): Promise<O[]> {
            if (!next) {
                return results;
            }
            const nextPage = await ajax({url: next, method: 'GET'});
            return [...results, ...await handlePage(nextPage.data)];
        }
        return this.getPage(input).then(handlePage);
    }
    public validateGet(input: I): I {
        return this.validate('GET', input);
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

export interface EndpointMethodHandler<A extends AuthenticationType> {
    auth: A;
    validate(input: any): any;
    serializeRequest(input: any): MethodHandlerRequest;
    deserializeRequest(request: MethodHandlerRequest): any;
    serializeResponseData(data: any): any;
    deserializeResponseData(data: any): any;
}

export class PayloadMethodHandler<A extends AuthenticationType> implements EndpointMethodHandler<A> {
    constructor(private urlSerializer: Serializer, private payloadSerializer: Serializer, private resourceSerializer: Serializer, public auth: A) {}

    public validate(input: any) {
        return {
            ...this.payloadSerializer.validate(input),
            ...this.urlSerializer.validate(input),
        };
    }
    public serializeRequest(input: any): MethodHandlerRequest {
        const urlParameters = this.urlSerializer.encode(input);
        const payload = this.payloadSerializer.serialize(input);
        return {urlParameters, payload};
    }
    public deserializeRequest(request: MethodHandlerRequest): any {
        return {
            ...this.payloadSerializer.deserialize(request.payload),
            ...this.urlSerializer.decode(request.urlParameters),
        };
    }
    public serializeResponseData(output: any): any {
        return this.resourceSerializer.serialize(output);
    }
    public deserializeResponseData(output: any): any {
        return this.resourceSerializer.deserialize(output);
    }
}

export class ReadMethodHandler<A extends AuthenticationType> implements EndpointMethodHandler<A> {
    constructor(private urlSerializer: Serializer, private resourceSerializer: Serializer, public auth: A) {}

    public validate(input: any) {
        return this.urlSerializer.validate(input);
    }
    public serializeRequest(input: any): MethodHandlerRequest {
        return {urlParameters: this.urlSerializer.encode(input)};
    }
    public deserializeRequest(request: MethodHandlerRequest) {
        return this.urlSerializer.decode(request.urlParameters);
    }
    public serializeResponseData(output: any): any {
        return this.resourceSerializer.serialize(output);
    }
    public deserializeResponseData(output: any): any {
        return this.resourceSerializer.deserialize(output);
    }
}

export class NoContentMethodHandler<A extends AuthenticationType> implements EndpointMethodHandler<A> {
    constructor(private urlSerializer: Serializer, public auth: A) {}

    public validate(input: any) {
        return this.urlSerializer.validate(input);
    }
    public serializeRequest(input: any): MethodHandlerRequest {
        return {urlParameters: this.urlSerializer.encode(input)};
    }
    public deserializeRequest(request: MethodHandlerRequest) {
        return this.urlSerializer.decode(request.urlParameters);
    }
    public serializeResponseData(data: any): void {
        return data;
    }
    public deserializeResponseData(data: any): void {
        return data;
    }
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

    public static create<S, U extends keyof S>(resource: Resource<S>, pathPattern: string, pathKeywords: U[]) {
        return new ApiEndpoint(resource, pathPattern, pathKeywords, ['OPTIONS'], {
            OPTIONS: new NoContentMethodHandler(resource.pick(pathKeywords), 'none'),
        });
    }

    private urlResource = this.resource.pick(this.pathKeywords);
    private pathRegexp = makeUrlRegexp(this.pathPattern);

    private constructor(
        public readonly resource: Resource<S>,
        public readonly pathPattern: string, public readonly pathKeywords: U[],
        public readonly methods: HttpMethod[],
        public readonly methodHandlers: X,
        private readonly modelPrototypes: ApiModel[] = [],
    ) {}

    public listable<K extends keyof S>(orderingKeys: K[]): ListEndpointDefinition<S, U, K, 'none', T, X>;
    public listable<K extends keyof S, A extends AuthenticationType>(options: {auth: A, orderingKeys: K[]}): ListEndpointDefinition<S, U, K, A, T, X>;
    public listable<K extends keyof S, A extends AuthenticationType = 'none'>(options: K[] | {auth?: A, orderingKeys: K[]}): ListEndpointDefinition<S, U, K, A, T, X> {
        const orderingKeys = Array.isArray(options) ? options : options.orderingKeys;
        const auth = !Array.isArray(options) && options.auth || 'none' as A;
        const urlSerializer = new ListParamSerializer(this.resource, this.pathKeywords, orderingKeys);
        const pageResource = resource({
            next: nullable(url()),
            results: nestedList(this.resource),
        });
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: new ReadMethodHandler(urlSerializer, pageResource, auth)}),
            [...this.modelPrototypes, ListEndpointModel.prototype],
        );
    }

    public retrievable<A extends AuthenticationType = 'none'>(options?: {auth: A}): RetrieveEndpointDefinition<S, U, A, T, X> {
        const auth = options && options.auth || 'none' as A;
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords, [...this.methods, 'GET'],
            spread(this.methodHandlers, {GET: new ReadMethodHandler(this.urlResource, this.resource, auth)}),
            [...this.modelPrototypes, RetrieveEndpointModel.prototype],
        );
    }

    public creatable<R extends keyof S, O extends keyof S, D extends keyof S, A extends AuthenticationType = 'none'>(options: {auth?: A, required: R[], optional: O[], defaults: {[P in D]: S[P]}}): CreateEndpointDefinition<S, U, R, O, D, A, T, X> {
        const payloadResource = this.resource.optional(options);
        const auth = options.auth || 'none' as A;
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords, [...this.methods, 'POST'],
            spread(this.methodHandlers, {POST: new PayloadMethodHandler(this.urlResource, payloadResource, this.resource, auth)}),
            [...this.modelPrototypes, CreateEndpointModel.prototype],
        );
    }

    public updateable<R extends keyof S, O extends keyof S, D extends keyof S, A extends AuthenticationType = 'none'>(options: {auth?: A, required: R[], optional: O[], defaults: {[P in D]: S[P]}}): UpdateEndpointDefinition<S, U, R, O, D, A, T, X> {
        const {required, optional, defaults} = options;
        const auth = options.auth || 'none' as A;
        const replaceResource = this.resource.optional(options);
        const updateResource = this.resource.pick([...required, ...optional, ...keys(defaults)]).partial();
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords, [...this.methods, 'PUT', 'PATCH'],
            spread(this.methodHandlers, {
                PUT: new PayloadMethodHandler(this.urlResource, replaceResource, this.resource, auth),
                PATCH: new PayloadMethodHandler(this.urlResource, updateResource, this.resource, auth),
            }),
            [...this.modelPrototypes, UpdateEndpointModel.prototype],
        );
    }

    public destroyable<A extends AuthenticationType = 'none'>(options?: {auth: A}): DestroyEndpointDefinition<S, U, A, T, X> {
        const auth = options && options.auth || 'none' as A;
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords, [...this.methods, 'DELETE'],
            spread(this.methodHandlers, {DELETE: new NoContentMethodHandler(this.urlResource, auth)}),
            [...this.modelPrototypes, DestroyEndpointModel.prototype],
        );
    }

    public bind(rootUrl: string): T {
        class BoundApiEndpoint extends ApiModel {}
        Object.assign(BoundApiEndpoint.prototype, ...this.modelPrototypes);
        return new BoundApiEndpoint(rootUrl, this) as any;
    }

    public validate(method: HttpMethod, input: any): any {
        if (!this.hasMethod(method)) {
            throw new Error(`Unsupported method ${method}`);
        }
        return this.methodHandlers[method].validate(input);
    }

    public serializeRequest(method: HttpMethod, input: any): ApiRequest {
        if (!this.hasMethod(method)) {
            throw new Error(`Unsupported method ${method}`);
        }
        const {urlParameters, payload} = this.methodHandlers[method].serializeRequest(input);
        const queryParameters = {...urlParameters};
        const path = this.pathPattern.replace(/\{(\w+)\}/g, (_, urlKeyword: string) => {
            const urlValue = queryParameters[urlKeyword];
            delete queryParameters[urlKeyword];
            return urlEncode(urlValue);
        });
        return {method, path, queryParameters, payload};
    }

    public deserializeRequest(request: ApiRequest) {
        const {method, queryParameters, payload} = request;
        if (!this.hasMethod(method)) {
            throw new Error(`Unsupported method ${method}`);
        }
        const pathMatch = this.pathRegexp.exec(request.path);
        if (!pathMatch) {
            // The path does not match this endpoint!
            return null;
        }
        const {pathKeywords} = this;
        const urlParameters = {...queryParameters};
        for (let i = 0; i < pathKeywords.length; i++) {
            const pathKey = pathKeywords[i];
            try {
                urlParameters[pathKey] = decodeURIComponent(pathMatch[i + 1]);
            } catch {
                // Malformed URI component -> do not accept this URL
                return null;
            }
        }
        return this.methodHandlers[method].deserializeRequest({payload, urlParameters});
    }

    public serializeResponseData(method: HttpMethod, data: any) {
        if (!this.hasMethod(method)) {
            throw new Error(`Unsupported method ${method}`);
        }
        return this.methodHandlers[method].serializeResponseData(data);
    }

    public deserializeResponseData(method: HttpMethod, data: any) {
        if (!this.hasMethod(method)) {
            throw new Error(`Unsupported method ${method}`);
        }
        return this.methodHandlers[method].deserializeResponseData(data);
    }

    private hasMethod(method: HttpMethod): method is keyof X & HttpMethod {
        return this.methodHandlers.hasOwnProperty(method);
    }
}

export function endpoint<R>(resource: Resource<R>) {
    function url<K extends keyof R = never>(strings: TemplateStringsArray, ...keywords: K[]): ApiEndpoint<R, K, {}, OptionsEndpointMethodMapping> {
        return ApiEndpoint.create(resource, buildUrl(strings, keywords), keywords);
    }
    return {url};
}

export type ApiEndpoints<T> = {[P in keyof T]: EndpointDefinition<T[P], EndpointMethodMapping>};

export function init<T>(rootUrl: string, endpoints: ApiEndpoints<T>, callback: (apis: T) => void) {
    const apis = transformValues(endpoints, (ep: EndpointDefinition<any, EndpointMethodMapping>) => ep.bind(rootUrl)) as T;
    callback(apis);
}

const urlEncode = encodeURIComponent;
