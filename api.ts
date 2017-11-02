// tslint:disable:max-classes-per-file
import filter = require('lodash/filter');
import keys = require('lodash/keys');
import omit = require('lodash/omit');
import pick = require('lodash/pick');
import { Observable } from 'rxjs';
import { ajax } from 'rxjs/observable/dom/ajax';
import { choice, Field, string } from './fields';
import { HttpMethod } from './http';
import { ListSerializer, ResourceFieldSet } from './resources';
import { makeUrlRegexp } from './url';

export { Field };

declare const __API_ORIGIN__: string;

export interface Endpoint<IE, II, PE, PI, OE, OI, RI, RE> {
    methods: HttpMethod[];
    auth: boolean;
    url: string;
    urlRegexp: RegExp;
    urlKeys: string[];
    identifier: ResourceFieldSet<IE, II>;
    requiredPayload: ResourceFieldSet<PE, PI>;
    optionalPayload: ResourceFieldSet<OE, OI>;
    attrs: ResourceFieldSet<RE, RI>;
    parseUrl(url: string): IE | null;
    getUrl(url: IE): string;
}

export interface IApiListPage<T> {
    next: string | null;
    results: T[];
}

export interface ListParams<K extends keyof R, R> {
    ordering: K;
    direction: 'asc' | 'desc';
    since: R[K];
}

export abstract class Api<ClientInput, ServerInput> {
    public abstract readonly methods: HttpMethod[];

    public readonly pathComponents: string[] = this.url.split('/');
    public readonly identifierKeys = keys(this.identifier);
    public readonly urlKeys = filter(
        this.identifierKeys,
        (key) => this.pathComponents.indexOf(`{${key}}`) >= 0,
    );
    public readonly urlRegexp = makeUrlRegexp(this.url);

    constructor(
        public readonly identifier: ResourceFieldSet<ClientInput, ServerInput>,
        public readonly url: string,
        public readonly auth: boolean,
    ) {}

    public parseUrl(url: string): ClientInput | null {
        const identifier: {[key: string]: Field<any, any>} = this.identifier;
        const input: {[key: string]: any} = {};
        const patternComponents = this.pathComponents;
        const [path, query] = url.split('?');
        const splittedUrl = path.split('/');
        if (patternComponents.length !== splittedUrl.length) {
            return null;
        }
        for (let i = 0; i < splittedUrl.length; i ++) {
            const urlComponent = splittedUrl[i];
            const patternComponent = patternComponents[i];
            const keywordMatch = /^{(\w+)}$/.exec(patternComponent);
            if (keywordMatch) {
                input[keywordMatch[1]] = decodeURIComponent(urlComponent);
            } else if (urlComponent !== patternComponent) {
                return null;
            }
        }
        if (query) {
            for (const queryPart of query.split('&')) {
                const [key, value] = queryPart.split('=');
                if (key != null && value != null && key in identifier && this.urlKeys.indexOf(key) < 0) {
                    const field = identifier[key] as Field<any, any>;
                    let decodedKey: string;
                    let decodedValue: string;
                    try {
                        decodedKey = decodeURIComponent(key);
                        decodedValue = decodeURIComponent(value);
                    } catch {
                        // Incorrectly encoded URI components. Ignore them.
                        continue;
                    }
                    // TODO: Deserialization instead of 'input'
                    input[decodedKey] = field.input(decodedValue);
                }
            }
        }
        return input as ClientInput;
    }

    public getUrl(input: ClientInput | ServerInput): string {
        const identifier: {[key: string]: Field<any, any>} = this.identifier;
        const path = this.url.replace(/{(\w+)}/g, (_, key) => {
            const value = (input as any)[key];
            if (value == null) {
                throw Error(`URL component "${key}" is missing a value.`);
            }
            return encodeURIComponent(value);
        });
        const queryParams = [];
        for (const key in this.identifier) {
            if (identifier.hasOwnProperty(key) && this.urlKeys.indexOf(key) < 0 && (input as any)[key] != null) {
                const value = (input as any)[key]; // TODO
                const field = identifier[key];
                // TODO: Serialization instead of 'output'
                queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(field.output(value))}`);
            }
        }
        const query = queryParams.length ? `?${queryParams.join('&')}` : '';
        return `${__API_ORIGIN__}${path}${query}`;
    }
}

export abstract class ResponseApi<ClientInput, ServerInput, ServerResponse, ClientResponse> extends Api<ClientInput, ServerInput> {

    constructor(
        public readonly attrs: ResourceFieldSet<ClientResponse, ServerResponse>,
        identifier: ResourceFieldSet<ClientInput, ServerInput>, url: string, auth: boolean,
    ) {
        super(identifier, url, auth);
    }
}

export abstract class PayloadApi<IE, II, PE, PI, OE, OI, ResI, ResE> extends ResponseApi<IE, II, ResI, ResE> {

    constructor(
        public readonly requiredPayload: ResourceFieldSet<PE, PI>,
        public readonly optionalPayload: ResourceFieldSet<OE, OI>,
        attrs: ResourceFieldSet<ResE, ResI>,
        identifier: ResourceFieldSet<IE, II>, url: string, auth: boolean,
    ) {
        super(attrs, identifier, url, auth);
    }

    public deserialize(input: any): IE & PE & OE {
        // return mapValues(
        //     this.params as Dictionary<Field<any, any>>,
        //     (field, name) => field.input(input[name]),
        // ) as II & PI & OI;
        return input as any; // TODO
    }
}

export class RetrieveApi<ClientInput, ServerInput, ServerResponse, ClientResponse>
    extends ResponseApi<ClientInput, ServerInput, ServerResponse, ClientResponse>
    implements Endpoint<ClientInput, ServerInput, void, void, void, void, ServerResponse, ClientResponse> {

    public methods = ['GET', 'HEAD'] as HttpMethod[];

    public readonly requiredPayload: ResourceFieldSet<void, void>;
    public readonly optionalPayload: ResourceFieldSet<void, void>;

    public get(input: ServerInput): Observable<ClientResponse> {
        // TODO: Validate
        const method = 'GET';
        const url = this.getUrl(input);
        return ajax({method, url}).map((response) => response.response as ClientResponse);
    }
}

export class ListApi<ClientInput, ServerInput, ServerResponse, ClientResponse>
    extends RetrieveApi<ClientInput, ServerInput, IApiListPage<ServerResponse>, IApiListPage<ClientResponse>> {

    constructor(
        public readonly itemAttrs: ResourceFieldSet<ClientResponse, ServerResponse>,
        identifier: ResourceFieldSet<ClientInput, ServerInput>, url: string, auth: boolean,
    ) {
        super({
            next: string(),
            results: new ListSerializer(itemAttrs) as Field<ClientResponse[], ServerResponse[]>,
        }, identifier, url, auth);
    }

    public list(input: ServerInput): Observable<ClientResponse> {
        return this.get(input)
            .expand((page) => {
                if (page.next) {
                    return ajax({method: 'GET', url: page.next}).map((response) => response.response as IApiListPage<ClientResponse>);
                }
                return Observable.empty<IApiListPage<ClientResponse>>();
            })
            .concatMap((page) => page.results)
        ;
    }

    public paginated<K extends keyof ClientResponse & keyof ServerResponse>(orderingKey: K) {
        return new PaginatedListApi(orderingKey, this.itemAttrs, this.identifier, this.url, this.auth);
    }
}

export class PaginatedListApi<OrderingKeys extends keyof ClientResponse & keyof ServerResponse, ClientInput, ServerInput, ServerResponse, ClientResponse>
    extends ListApi<ClientInput & ListParams<OrderingKeys, ClientResponse>, ServerInput & ListParams<OrderingKeys, ServerResponse>, ServerResponse, ClientResponse> {

    constructor(
        public readonly orderingKey: OrderingKeys,
        itemAttrs: ResourceFieldSet<ClientResponse, ServerResponse>,
        identifier: ResourceFieldSet<ClientInput, ServerInput>, url: string, auth: boolean,
    ) {
        super(itemAttrs, paginatedInput(orderingKey, identifier, itemAttrs), url, auth);
    }
}

function paginatedInput<K extends keyof RE & keyof RI, IE, II, RI, RE>(key: K, input: ResourceFieldSet<IE, II>, attrs: ResourceFieldSet<RE, RI>): ResourceFieldSet<IE & ListParams<K, RE>, II & ListParams<K, RI>> {
    const x: ResourceFieldSet<IE, II> & ResourceFieldSet<ListParams<K, RE>, ListParams<K, RI>> = Object.assign({}, input, {
        ordering: choice([key]),
        direction: choice(['asc', 'desc']),
        since: (attrs as any)[key] as Field<RE[K], RI[K]>,
    });
    return x as any; // TODO
}

export class CreateApi<IE, II, PE, PI, OE, OI, ResI, ResE>
    extends PayloadApi<IE, II, PE, PI, OE, OI, ResI, ResE>
    implements Endpoint<IE, II, PE, PI, OE, OI, ResI, ResE> {

    public methods = ['POST'] as HttpMethod[];

    public post(input: IE & PE & Partial<OE>): Observable<ResE> {
        // TODO: Validate
        const method = 'POST';
        const url = this.getUrl(input);
        const body = JSON.stringify(omit(input, this.identifierKeys));
        return ajax({method, url, body}).map((response) => response.response as ResE);
    }

    public payload<K extends keyof ResI & keyof ResE>(...requiredKeys: K[]) {
        type PE2 = Pick<ResE, K>;
        type PI2 = Pick<ResI, K>;
        return new CreateApi<IE, II, PE & PE2, PI & PI2, OE, OI, ResI, ResE>(
            {...this.requiredPayload as object, ...pick(this.attrs, requiredKeys) as object} as any,
            this.optionalPayload, this.attrs, this.identifier, this.url, this.auth,
        );
    }

    public optional<K extends keyof ResI & keyof ResE>(...optionalKeys: K[]) {
        type OE2 = Pick<ResE, K>;
        type OI2 = Pick<ResI, K>;
        return new CreateApi<IE, II, PE, PI, OE & OE2, OI & OI2, ResI, ResE>(
            this.requiredPayload,
            {...this.optionalPayload as object, ...pick(this.attrs, optionalKeys) as object} as any,
            this.attrs, this.identifier, this.url, this.auth,
        );
    }
}

export class UpdateApi<IE, II, PE, PI, OE, OI, ResI, ResE>
    extends PayloadApi<IE, II, PE, PI, OE, OI, ResI, ResE>
    implements Endpoint<IE, II, PE, PI, OE, OI, ResI, ResE> {

    public methods = ['PUT', 'PATCH'] as HttpMethod[];

    public put(input: IE & PE & Partial<OE>): Observable<ResE> {
        // TODO: Validate
        const method = 'PUT';
        const url = this.getUrl(input);
        const body = JSON.stringify(omit(input, this.identifierKeys));
        return ajax({method, url, body}).map((response) => response.response as ResE);
    }

    public patch(input: IE & Partial<PE> & Partial<OE>): Observable<ResE> {
        // TODO: Validate
        const method = 'PATCH';
        const url = this.getUrl(input);
        const body = JSON.stringify(omit(input, this.identifierKeys));
        return ajax({method, url, body}).map((response) => response.response as ResE);
    }

    public payload<K extends keyof ResI & keyof ResE>(...requiredKeys: K[]) {
        type PE2 = Pick<ResE, K>;
        type PI2 = Pick<ResI, K>;
        return new UpdateApi<IE, II, PE & PE2, PI & PI2, OE, OI, ResI, ResE>(
            {...this.requiredPayload as object, ...pick(this.attrs, requiredKeys) as object} as any,
            this.optionalPayload, this.attrs, this.identifier, this.url, this.auth,
        );
    }

    public optional<K extends keyof ResI & keyof ResE>(...optionalKeys: K[]) {
        type OE2 = Pick<ResE, K>;
        type OI2 = Pick<ResI, K>;
        return new UpdateApi<IE, II, PE, PI, OE & OE2, OI & OI2, ResI, ResE>(
            this.requiredPayload,
            {...this.optionalPayload as object, ...pick(this.attrs, optionalKeys) as object} as any,
            this.attrs, this.identifier, this.url, this.auth,
        );
    }
}

export class DestroyApi<ClientInput, ServerInput>
    extends Api<ClientInput, ServerInput>
    implements Endpoint<ClientInput, ServerInput, void, void, void, void, void, void> {
    public methods = ['DELETE'] as HttpMethod[];

    public readonly requiredPayload: ResourceFieldSet<void, void>;
    public readonly optionalPayload: ResourceFieldSet<void, void>;
    public readonly attrs: ResourceFieldSet<void, void>;

    public delete(input: ClientInput): Observable<never> {
        // TODO: Validate
        const method = 'DELETE';
        const url = this.getUrl(input);
        return ajax({method, url}).ignoreElements() as Observable<never>;
    }
}

export function retrieve<E, I, R extends ResourceFieldSet<E, I>>(resource: ResourceFieldSet<E, I> & R) {
    function urlToApi(strings: TemplateStringsArray): RetrieveApi<{}, {}, I, E>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]): RetrieveApi<Pick<E, K>, Pick<I, K>, I, E>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]) {
        type IE = Pick<E, K>;
        type II = Pick<I, K>;
        // TODO: If only one string was given, then parse any '{...}' placeholders from it!
        const url = buildUrl(strings, keywords);
        // TODO: Fail if the keywords were not found from the resource
        const identifier = pick(resource, keywords) as ResourceFieldSet<IE, II>;
        return new RetrieveApi(resource, identifier, url, false);
    }
    return {url: urlToApi};
}

export function list<E, I, R extends ResourceFieldSet<E, I>>(resource: ResourceFieldSet<E, I> & R) {
    function urlToApi(strings: TemplateStringsArray): ListApi<{}, {}, I, E>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]): ListApi<Pick<E, K>, Pick<I, K>, I, E>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]) {
        type IE = Pick<E, K>;
        type II = Pick<I, K>;
        const url = buildUrl(strings, keywords);
        const identifier = pick(resource, keywords) as ResourceFieldSet<IE, II>;
        return new ListApi(resource, identifier, url, false);
    }
    return {url: urlToApi};
}

export function create<E, I, R extends ResourceFieldSet<E, I>>(resource: ResourceFieldSet<E, I> & R) {
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray): CreateApi<{}, {}, {}, {}, {}, {}, I, E>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]): CreateApi<Pick<E, K>, Pick<I, K>, {}, {}, {}, {}, I, E>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]) {
        type IE = Pick<E, K>;
        type II = Pick<I, K>;
        const url = buildUrl(strings, keywords);
        const identifier = pick(resource, keywords) as ResourceFieldSet<IE, II>;
        return new CreateApi({}, {}, resource, identifier, url, false);
    }
    return {url: urlToApi};
}

export function update<E, I, R extends ResourceFieldSet<E, I>>(resource: ResourceFieldSet<E, I> & R) {
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray): UpdateApi<{}, {}, {}, {}, {}, {}, I, E>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]): UpdateApi<Pick<E, K>, Pick<I, K>, {}, {}, {}, {}, I, E>;
    function urlToApi<K1 extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K1[]) {
        type IE = Pick<E, K1>;
        type II = Pick<I, K1>;
        const url = buildUrl(strings, keywords);
        const identifier = pick(resource, keywords) as ResourceFieldSet<IE, II>;
        return new UpdateApi({}, {}, resource, identifier, url, false);
    }
    return {url: urlToApi};
}

export function destroy<E, I, R extends ResourceFieldSet<E, I>>(resource: ResourceFieldSet<E, I> & R) {
    function urlToApi(strings: TemplateStringsArray): DestroyApi<{}, {}>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]): DestroyApi<Pick<E, K>, Pick<I, K>>;
    function urlToApi<K extends keyof E & keyof I>(strings: TemplateStringsArray, ...keywords: K[]) {
        type IE = Pick<E, K>;
        type II = Pick<I, K>;
        const url = buildUrl(strings, keywords);
        const identifier = pick(resource, keywords) as ResourceFieldSet<IE, II>;
        return new DestroyApi(identifier, url, false);
    }
    return {url: urlToApi};
}

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
