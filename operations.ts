import { CreateApi, DestroyApi, ListApi, RetrieveEndpoint, UpdateApi } from './api';
import { Bindable, Client } from './client';
import { Endpoint } from './endpoints';
import { nullable } from './fields';
import { AuthenticatedHttpRequest, HttpMethod, HttpRequest, SuccesfulResponse } from './http';
import { Cursor, CursorSerializer, Page, PageResponse } from './pagination';
import { Route, route } from './routes';
import { FieldSerializer, nested, nestedList, OptionalOptions, OptionalOutput, Serializer } from './serializers';
import { Key, keys } from './utils/objects';

export interface Operation<I, O, R> {
    type: 'retrieve' | 'update' | 'destroy' | 'list' | 'create';
    authType: AuthenticationType;
    methods: HttpMethod[];
    route: Route<any, any>;
    userIdAttribute?: string;
    responseSerializer: Serializer | null;
    getPayloadSerializer(method: HttpMethod): Serializer | null;
    /**
     * This method only works as a hint to TypeScript to correctly
     * interprete operations as correct Implementable types.
     */
    asImplementable(): Operation<I, O, R>;
}

export interface AuthRequestMapping {
    none: HttpRequest;
    user: AuthenticatedHttpRequest;
    owner: AuthenticatedHttpRequest;
    admin: AuthenticatedHttpRequest;
}

export type AuthenticationType = keyof AuthRequestMapping;

interface CommonEndpointOptions<A extends AuthenticationType, B extends undefined | keyof any> {
    auth?: A;
    ownership?: B;
}

abstract class BaseOperation<S, U extends Key<S>, A extends AuthenticationType, B extends U | undefined> {
    public abstract readonly methods: HttpMethod[];
    public abstract readonly route: Route<any, U>;

    constructor(
        public readonly endpoint: Endpoint<S, any, any, U>,
        public readonly authType: A,
        public readonly userIdAttribute: B,
    ) {}
}

export class ListOperation<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, A, B>
implements Bindable<ListApi<S, U, O, F, B>>, Operation<Cursor<S, U, O, F>, PageResponse<S, U, O, F>, AuthRequestMapping[A]> {
    public readonly type: 'list' = 'list';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly urlSerializer = new CursorSerializer(
        this.endpoint.resource,
        this.endpoint.pattern.pathKeywords,
        this.orderingKeys,
        this.filteringKeys,
    );
    public readonly route = route(this.endpoint.pattern, this.urlSerializer);
    public readonly responseSerializer: Serializer<Page<S, Cursor<S, U, O, F>>> = new FieldSerializer({
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
    public bind(client: Client): ListApi<S, U, O, F, B> {
        return new ListApi(this, client);
    }
    public getPayloadSerializer() {
        return null;
    }
    public asImplementable(): Operation<Cursor<S, U, O, F>, PageResponse<S, U, O, F>, AuthRequestMapping[A]> {
        return this;
    }
}

export class RetrieveOperation<S, U extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, A, B>
implements Bindable<RetrieveEndpoint<S, U, B>>, Operation<Pick<S, U>, S, AuthRequestMapping[A]> {
    public readonly type: 'retrieve' = 'retrieve';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly route = route(
        this.endpoint.pattern,
        this.endpoint.resource.pick(this.endpoint.pattern.pathKeywords),
    );
    public readonly responseSerializer = this.endpoint.resource;
    public bind(client: Client): RetrieveEndpoint<S, U, B> {
        return new RetrieveEndpoint(this, client);
    }
    public getPayloadSerializer() {
        return null;
    }
    public asImplementable(): Operation<Pick<S, U>, S, AuthRequestMapping[A]> {
        return this;
    }
}

export class CreateOperation<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, A, B>
implements Bindable<CreateApi<S, U, R, O, D, B>>, Operation<OptionalOutput<S, R, O, D>, SuccesfulResponse<S>, AuthRequestMapping[A]> {
    public readonly type: 'create' = 'create';
    public readonly methods: HttpMethod[] = ['POST'];
    public readonly route = this.endpoint.asRoute();
    public readonly payloadSerializer = this.endpoint.resource.optional(this.options);
    public readonly responseSerializer = this.endpoint.resource;
    constructor(
        readonly endpoint: Endpoint<S, any, any, U>,
        private readonly options: OptionalOptions<S, R, O, D>,
        readonly authType: A,
        readonly userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public bind(client: Client): CreateApi<S, U, R, O, D, B> {
        return new CreateApi(this, client);
    }
    public getPayloadSerializer() {
        return this.payloadSerializer;
    }
    public asImplementable(): Operation<Pick<S, R | U | D> & Partial<Pick<S, O>>, SuccesfulResponse<S>, AuthRequestMapping[A]> {
        return this;
    }
}

export class UpdateOperation<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, A, B>
implements Bindable<UpdateApi<S, U, R, O, D, B>>, Operation<OptionalOutput<S, R, O, D>, SuccesfulResponse<S>, AuthRequestMapping[A]> {
    public readonly type: 'update' = 'update';
    public readonly methods: HttpMethod[] = ['PUT', 'PATCH'];
    public readonly route = this.endpoint.asRoute();
    public readonly replaceSerializer = this.endpoint.resource.optional(this.options);
    public readonly updateSerializer = this.endpoint.resource
        .pick([...this.options.required, ...this.options.optional, ...keys(this.options.defaults)])
        .fullPartial()
    ;
    public readonly responseSerializer = this.endpoint.resource;
    constructor(
        endpoint: Endpoint<S, any, any, any>,
        private readonly options: OptionalOptions<S, R, O, D>,
        authType: A,
        userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public bind(client: Client): UpdateApi<S, U, R, O, D, B> {
        return new UpdateApi(this, client);
    }
    public getPayloadSerializer(method: HttpMethod): Serializer {
        return method === 'PATCH' ? this.updateSerializer : this.replaceSerializer;
    }
    public asImplementable(): Operation<Pick<S, R | U | D> & Partial<Pick<S, O>>, SuccesfulResponse<S>, AuthRequestMapping[A]> {
        return this;
    }
}

export class DestroyOperation<S, U extends Key<S>, A extends AuthenticationType, B extends U | undefined>
extends BaseOperation<S, U, A, B>
implements Bindable<DestroyApi<S, U, B>>, Operation<Pick<S, U>, void, AuthRequestMapping[A]> {
    public readonly type: 'destroy' = 'destroy';
    public readonly methods: HttpMethod[] = ['DELETE'];
    public readonly route = this.endpoint.asRoute();
    public readonly responseSerializer = null;
    public bind(client: Client): DestroyApi<S, U, B> {
        return new DestroyApi(this, client);
    }
    public getPayloadSerializer() {
        return null;
    }
    public asImplementable(): Operation<Pick<S, U>, void, AuthRequestMapping[A]> {
        return this;
    }
}

export function listable<S, U extends Key<S>, O extends Key<S>, F extends Key<S> = never, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
    endpoint: Endpoint<S, any, any, U>,
    options: CommonEndpointOptions<A, B> & {orderingKeys: O[], filteringKeys?: F[]},
): ListOperation<S, U, O, F, A, B> {
    return new ListOperation(
        endpoint, options.orderingKeys, options.filteringKeys || [], options.auth || 'none' as A, options.ownership as B,
    );
}

export function creatable<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
    endpoint: Endpoint<S, any, any, U>,
    options: CommonEndpointOptions<A, B> & OptionalOptions<S, R, O, D>,
): CreateOperation<S, U, R, O, D, A, B> {
    const {auth = 'none' as A, ownership, ...opts} = options;
    return new CreateOperation(endpoint, opts, auth, ownership as B);
}

export function retrievable<S, U extends Key<S>, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
    endpoint: Endpoint<S, any, any, U>,
    options?: CommonEndpointOptions<A, B>,
): RetrieveOperation<S, U, A, B> {
    const {auth = 'none' as A} = options || {};
    return new RetrieveOperation(endpoint, auth, (options && options.ownership) as B);
}

export function updateable<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
    endpoint: Endpoint<S, any, any, U>,
    options: CommonEndpointOptions<A, B> & OptionalOptions<S, R, O, D>,
): UpdateOperation<S, U, R, O, D, A, B> {
    const {auth = 'none' as A, ownership, ...opts} = options;
    return new UpdateOperation(endpoint, opts, auth, ownership as B);
}

export function destroyable<S, U extends Key<S>, A extends AuthenticationType = 'none', B extends U | undefined = undefined>(
    endpoint: Endpoint<S, any, any, U>,
    options?: CommonEndpointOptions<A, B>,
): DestroyOperation<S, U, A, B> {
    const {auth = 'none' as A} = options || {};
    return new DestroyOperation(endpoint, auth, (options && options.ownership) as B);
}
