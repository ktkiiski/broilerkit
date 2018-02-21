// tslint:disable:max-classes-per-file
// tslint:disable:no-shadowed-variable
import mapValues = require('lodash/mapValues');
import { ajax } from './ajax';
import { choice, Field, nullable, url } from './fields';
import { HttpHeaders, HttpMethod, HttpStatus } from './http';
import { EncodedResource, nestedList, Resource, resource, SerializedResource, Serializer } from './resources';
import { compileUrl, makeUrlRegexp } from './url';
import { keys } from './utils/objects';

export { Field };

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

interface MethodHandlerRequest {
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

export interface EndpointDefinition<T> {
    methods: HttpMethod[];
    pathPattern: string;
    bind(origin: string): T;
    validate(method: HttpMethod, input: any): any;
    serializeRequest(method: HttpMethod, input: any): ApiRequest;
    deserializeRequest(request: ApiRequest): any;
    serializeResponseData(method: HttpMethod, data: any): any;
    deserializeResponseData(method: HttpMethod, data: any): any;
}

class ApiModel {
    constructor(
        public origin: string,
        private endpoint: EndpointDefinition<any>,
    ) { }

    public async request(method: HttpMethod, input: any): Promise<any> {
        const {endpoint} = this;
        const {path, queryParameters, payload} = endpoint.serializeRequest(method, input);
        const url = compileUrl(this.origin, path, queryParameters);
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

interface EndpointMethodHandler {
    validate(input: any): any;
    serializeRequest(input: any): MethodHandlerRequest;
    deserializeRequest(request: MethodHandlerRequest): any;
    serializeResponseData(data: any): any;
    deserializeResponseData(data: any): any;
}

class PayloadMethodHandler implements EndpointMethodHandler {
    constructor(private urlSerializer: Serializer, private payloadSerializer: Serializer, private resourceSerializer: Serializer) {}

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

class ReadMethodHandler implements EndpointMethodHandler {
    constructor(private urlSerializer: Serializer, private resourceSerializer: Serializer) {}

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

class NoContentMethodHandler implements EndpointMethodHandler {
    constructor(private urlSerializer: Serializer) {}

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

export type ListEndpointDefinition<S, U extends keyof S, K extends keyof S, T = {}> = ApiEndpoint<S, U, ListEndpoint<ListParams<S, K> & Pick<S, U>, S> & T>;
export type RetrieveEndpointDefinition<S, U extends keyof S, T = {}> = ApiEndpoint<S, U, RetrieveEndpoint<Pick<S, U>, S> & T>;
export type CreateEndpointDefinition<S, U extends keyof S, R extends keyof S, O extends keyof S, D extends keyof S, T = {}> = ApiEndpoint<S, U, CreateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, S> & T>;

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

export class ApiEndpoint<S, U extends keyof S, T> implements EndpointDefinition<T> {

    public static create<S, U extends keyof S>(resource: Resource<S>, pathPattern: string, pathKeywords: U[]) {
        return new ApiEndpoint(resource, pathPattern, pathKeywords);
    }

    public methods = keys(this.methodHandlers) as HttpMethod[];
    private urlResource = this.resource.pick(this.pathKeywords);
    private pathRegexp = makeUrlRegexp(this.pathPattern);

    private constructor(
        public readonly resource: Resource<S>,
        public readonly pathPattern: string, public readonly pathKeywords: U[],
        private readonly methodHandlers: {[key: string]: EndpointMethodHandler} = {},
        private readonly modelPrototypes: ApiModel[] = [],
    ) {}

    public listable<K extends keyof S>(sortableKeys: K[]): ListEndpointDefinition<S, U, K, T> {
        const urlSerializer = new ListParamSerializer(this.resource, this.pathKeywords, sortableKeys);
        const pageResource = resource({
            next: nullable(url()),
            results: nestedList(this.resource),
        });
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords,
            {...this.methodHandlers, GET: new ReadMethodHandler(urlSerializer, pageResource)},
            [...this.modelPrototypes, ListEndpointModel.prototype],
        );
    }

    public retrievable(): RetrieveEndpointDefinition<S, U, T> {
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords,
            {...this.methodHandlers, GET: new ReadMethodHandler(this.urlResource, this.resource)},
            [...this.modelPrototypes, RetrieveEndpointModel.prototype],
        );
    }

    public creatable<R extends keyof S, O extends keyof S, D extends keyof S>(options: {required: R[], optional: O[], defaults: {[P in D]: S[P]}}): CreateEndpointDefinition<S, U, R, O, D, T> {
        const payloadResource = this.resource.optional(options);
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords,
            {...this.methodHandlers, POST: new PayloadMethodHandler(this.urlResource, payloadResource, this.resource)},
            [...this.modelPrototypes, CreateEndpointModel.prototype],
        );
    }

    public updateable<R extends keyof S, O extends keyof S, D extends keyof S>(options: {required: R[], optional: O[], defaults: {[P in D]: S[P]}}): ApiEndpoint<S, U, UpdateEndpoint<Pick<S, R | U> & Partial<Pick<S, O | D>>, Pick<S, R | U | D> & Partial<Pick<S, O>>, Pick<S, U> & Partial<Pick<S, R | O | D>>, S> & T> {
        const {required, optional, defaults} = options;
        const replaceResource = this.resource.optional(options);
        const updateResource = this.resource.pick([...required, ...optional, ...keys(defaults)]).partial();
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords,
            {
                ...this.methodHandlers,
                PUT: new PayloadMethodHandler(this.urlResource, replaceResource, this.resource),
                PATCH: new PayloadMethodHandler(this.urlResource, updateResource, this.resource),
            },
            [...this.modelPrototypes, UpdateEndpointModel.prototype],
        );
    }

    public destroyable(): ApiEndpoint<S, U, DestroyEndpoint<Pick<S, U>> & T> {
        return new ApiEndpoint(
            this.resource, this.pathPattern, this.pathKeywords,
            {...this.methodHandlers, DELETE: new NoContentMethodHandler(this.urlResource)},
            [...this.modelPrototypes, DestroyEndpointModel.prototype],
        );
    }

    public bind(origin: string): T {
        class BoundApiEndpoint extends ApiModel {}
        Object.assign(BoundApiEndpoint.prototype, ...this.modelPrototypes);
        return new BoundApiEndpoint(origin, this) as any;
    }

    public validate(method: HttpMethod, input: any): any {
        return this.methodHandlers[method].validate(input);
    }

    public serializeRequest(method: HttpMethod, input: any): ApiRequest {
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
        return this.methodHandlers[method].serializeResponseData(data);
    }

    public deserializeResponseData(method: HttpMethod, data: any) {
        return this.methodHandlers[method].deserializeResponseData(data);
    }
}

export function endpoint<R>(resource: Resource<R>) {
    function url<K extends keyof R = never>(strings: TemplateStringsArray, ...keywords: K[]): ApiEndpoint<R, K, {}> {
        return ApiEndpoint.create(resource, buildUrl(strings, keywords), keywords);
    }
    return {url};
}

export type ApiEndpoints<T> = {[P in keyof T]: EndpointDefinition<T[P]>};

export function init<T>(origin: string, endpoints: ApiEndpoints<T>, callback: (apis: T) => void) {
    const apis = mapValues(endpoints, (ep: EndpointDefinition<any>) => ep.bind(origin)) as T;
    callback(apis);
}

const urlEncode = encodeURIComponent;
