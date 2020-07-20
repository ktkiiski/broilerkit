/* eslint-disable @typescript-eslint/no-explicit-any */
import build from 'immuton/build';
import { Key } from 'immuton/types';
import { CreateApi, DestroyApi, UpdateApi, UploadApi } from './api';
import { Bindable, Client } from './client';
import { DecodedDataUri } from './data-uri';
import { Endpoint } from './endpoints';
import { data, nullable } from './fields';
import { AuthenticatedHttpRequest, HttpMethod, HttpRequest, SuccesfulResponse } from './http';
import { keys } from './objects';
import { Cursor, CursorSerializer, Page, PageResponse } from './pagination';
import { Route, route } from './routes';
import {
    ExtendableSerializer,
    FieldSerializer,
    nested,
    nestedList,
    OptionalOptions,
    OptionalOutput,
    OptionalInput,
    Serializer,
} from './serializers';

export type OperationType = 'retrieve' | 'update' | 'destroy' | 'list' | 'create' | 'upload';

export interface Operation<I, O, R, T extends OperationType = OperationType> {
    type: T;
    authType: AuthenticationType;
    methods: HttpMethod[];
    route: Route<any, any>;
    userIdAttribute?: string;
    responseSerializer: Serializer | null;
    endpoint: Endpoint<any, any, any>;
    getPayloadSerializer(method: HttpMethod): Serializer | null;
    /**
     * This method only works as a hint to TypeScript to correctly
     * interprete operations as correct Implementable types.
     */
    asImplementable(): Operation<I, O, R, T>;
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
        public readonly endpoint: Endpoint<S, any, U>,
        public readonly authType: A,
        public readonly userIdAttribute: B,
    ) {}
}

export class ListOperation<
    S,
    U extends Key<S>,
    O extends Key<S>,
    F extends Key<S>,
    A extends AuthenticationType,
    B extends U | undefined
> extends BaseOperation<S, U, A, B>
    implements Operation<Cursor<S, U, O, F>, PageResponse<S>, AuthRequestMapping[A], 'list'> {
    public readonly type = 'list';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly urlSerializer = new CursorSerializer(
        this.endpoint.resource,
        this.endpoint.pattern.pathKeywords,
        this.orderingKeys,
        this.filteringKeys,
    );
    public readonly route = route(this.endpoint.pattern, this.urlSerializer);
    public readonly responseSerializer: Serializer<Page<S, Cursor<S, U, O, F>>> = new FieldSerializer({
        next: nullable(nested(this.urlSerializer as any)),
        results: nestedList(this.endpoint.resource),
    });
    constructor(
        endpoint: Endpoint<S, any, U>,
        private readonly orderingKeys: O[],
        private readonly filteringKeys: F[],
        authType: A,
        userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public getPayloadSerializer(): null {
        return null;
    }
    public asImplementable(): Operation<Cursor<S, U, O, F>, PageResponse<S>, AuthRequestMapping[A], 'list'> {
        return this;
    }
}

export class RetrieveOperation<S, U extends Key<S>, A extends AuthenticationType, B extends U | undefined>
    extends BaseOperation<S, U, A, B>
    implements Operation<Pick<S, U>, S, AuthRequestMapping[A], 'retrieve'> {
    public readonly type = 'retrieve';
    public readonly methods: HttpMethod[] = ['GET'];
    public readonly route = route(
        this.endpoint.pattern,
        this.endpoint.resource.pick(this.endpoint.pattern.pathKeywords),
    );
    public readonly responseSerializer = this.endpoint.resource;
    public getPayloadSerializer(): null {
        return null;
    }
    public asImplementable(): Operation<Pick<S, U>, S, AuthRequestMapping[A], 'retrieve'> {
        return this;
    }
}

export class CreateOperation<
    S,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    A extends AuthenticationType,
    B extends U | undefined
> extends BaseOperation<S, U, A, B>
    implements
        Bindable<CreateApi<S, U, R, O, D, B>>,
        Operation<OptionalOutput<S, R | U, O, D>, SuccesfulResponse<S>, AuthRequestMapping[A], 'create'> {
    public readonly type = 'create';
    public readonly methods: HttpMethod[] = ['POST'];
    public readonly route = this.endpoint.asRoute();
    public readonly responseSerializer = this.endpoint.resource;
    private readonly payloadSerializer = this.endpoint.resource.optional(this.options);
    constructor(
        readonly endpoint: Endpoint<S, any, U>,
        private readonly options: OptionalOptions<S, R, O, D>,
        readonly authType: A,
        readonly userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public bind(client: Client): CreateApi<S, U, R, O, D, B> {
        return new CreateApi(this, client);
    }
    public getPayloadSerializer(): ExtendableSerializer<OptionalInput<S, R, O, D>, OptionalOutput<S, R, O, D>> {
        return this.payloadSerializer;
    }
    public asImplementable(): Operation<
        OptionalOutput<S, R | U, O, D>,
        SuccesfulResponse<S>,
        AuthRequestMapping[A],
        'create'
    > {
        return this;
    }
}

export class UpdateOperation<
    S,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    A extends AuthenticationType,
    B extends U | undefined
> extends BaseOperation<S, U, A, B>
    implements
        Bindable<UpdateApi<S, U, R, O, D, B>>,
        Operation<OptionalOutput<S, R | U, O, D>, SuccesfulResponse<S>, AuthRequestMapping[A], 'update'> {
    public readonly type = 'update';
    public readonly methods: HttpMethod[] = ['PUT', 'PATCH'];
    public readonly route = this.endpoint.asRoute();
    public readonly replaceSerializer = this.endpoint.resource.optional(this.options);
    public readonly updateSerializer = this.endpoint.resource
        .pick([...this.options.required, ...this.options.optional, ...keys(this.options.defaults)])
        .fullPartial();
    public readonly responseSerializer = this.endpoint.resource;
    constructor(
        endpoint: Endpoint<S, any, any>,
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
    public asImplementable(): Operation<
        OptionalOutput<S, R | U, O, D>,
        SuccesfulResponse<S>,
        AuthRequestMapping[A],
        'update'
    > {
        return this;
    }
}

export class DestroyOperation<S, U extends Key<S>, A extends AuthenticationType, B extends U | undefined>
    extends BaseOperation<S, U, A, B>
    implements Bindable<DestroyApi<S, U, B>>, Operation<Pick<S, U>, void, AuthRequestMapping[A], 'destroy'> {
    public readonly type = 'destroy';
    public readonly methods: HttpMethod[] = ['DELETE'];
    public readonly route = this.endpoint.asRoute();
    public readonly responseSerializer = null;
    public bind(client: Client): DestroyApi<S, U, B> {
        return new DestroyApi(this, client);
    }
    public getPayloadSerializer(): null {
        return null;
    }
    public asImplementable(): Operation<Pick<S, U>, void, AuthRequestMapping[A], 'destroy'> {
        return this;
    }
}

export interface UploadOptions<S, F extends string, R extends keyof S, O extends keyof S, D extends keyof S>
    extends OptionalOptions<S, R, O, D> {
    files: F[];
}

export class UploadOperation<
    S,
    F extends string,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    A extends AuthenticationType,
    B extends U | undefined
> extends BaseOperation<S, U, A, B>
    implements
        Bindable<UploadApi<S, F, U, R, O, D, B>>,
        Operation<
            OptionalOutput<S, R | U, O, D> & Record<F, DecodedDataUri>,
            SuccesfulResponse<S>,
            AuthRequestMapping[A],
            'upload'
        > {
    public readonly type = 'upload';
    public readonly methods: HttpMethod[] = ['POST'];
    public readonly route = this.endpoint.asRoute();
    public readonly responseSerializer = this.endpoint.resource;
    public readonly files: F[] = this.options.files;
    public readonly requestDataSerializer = this.endpoint.resource.optional(this.options);
    private readonly payloadSerializer = this.requestDataSerializer.extend(build(this.files, (key) => [key, data()]));
    constructor(
        readonly endpoint: Endpoint<S, any, U>,
        private readonly options: UploadOptions<S, F, R, O, D>,
        readonly authType: A,
        readonly userIdAttribute: B,
    ) {
        super(endpoint, authType, userIdAttribute);
    }
    public bind(client: Client): UploadApi<S, F, U, R, O, D, B> {
        return new UploadApi(this, client);
    }
    public getPayloadSerializer(): ExtendableSerializer<OptionalInput<S, R, O, D>, OptionalOutput<S, R, O, D>> {
        return this.payloadSerializer;
    }
    public asImplementable(): Operation<
        OptionalOutput<S, R | U, O, D> & Record<F, DecodedDataUri>,
        SuccesfulResponse<S>,
        AuthRequestMapping[A],
        'upload'
    > {
        return this;
    }
}

export function listable<
    S,
    U extends Key<S>,
    O extends Key<S>,
    F extends Key<S> = never,
    A extends AuthenticationType = 'none',
    B extends U | undefined = undefined
>(
    endpoint: Endpoint<S, any, U>,
    options: CommonEndpointOptions<A, B> & { orderingKeys: O[]; filteringKeys?: F[] },
): ListOperation<S, U, O, F, A, B> {
    return new ListOperation(
        endpoint,
        options.orderingKeys,
        options.filteringKeys || [],
        options.auth || ('none' as A),
        options.ownership as B,
    );
}

export function creatable<
    S,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    A extends AuthenticationType = 'none',
    B extends U | undefined = undefined
>(
    endpoint: Endpoint<S, any, U>,
    options: CommonEndpointOptions<A, B> & OptionalOptions<S, R, O, D>,
): CreateOperation<S, U, R, O, D, A, B> {
    const { auth = 'none' as A, ownership, ...opts } = options;
    return new CreateOperation(endpoint, opts, auth, ownership as B);
}

export function retrievable<
    S,
    U extends Key<S>,
    A extends AuthenticationType = 'none',
    B extends U | undefined = undefined
>(endpoint: Endpoint<S, any, U>, options?: CommonEndpointOptions<A, B>): RetrieveOperation<S, U, A, B> {
    const { auth = 'none' as A } = options || {};
    return new RetrieveOperation(endpoint, auth, (options && options.ownership) as B);
}

export function updateable<
    S,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    A extends AuthenticationType = 'none',
    B extends U | undefined = undefined
>(
    endpoint: Endpoint<S, any, U>,
    options: CommonEndpointOptions<A, B> & OptionalOptions<S, R, O, D>,
): UpdateOperation<S, U, R, O, D, A, B> {
    const { auth = 'none' as A, ownership, ...opts } = options;
    return new UpdateOperation(endpoint, opts, auth, ownership as B);
}

export function destroyable<
    S,
    U extends Key<S>,
    A extends AuthenticationType = 'none',
    B extends U | undefined = undefined
>(endpoint: Endpoint<S, any, U>, options?: CommonEndpointOptions<A, B>): DestroyOperation<S, U, A, B> {
    const { auth = 'none' as A } = options || {};
    return new DestroyOperation(endpoint, auth, (options && options.ownership) as B);
}

export function uploadable<
    S,
    F extends string,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    A extends AuthenticationType = 'none',
    B extends U | undefined = undefined
>(
    endpoint: Endpoint<S, any, U>,
    options: CommonEndpointOptions<A, B> & UploadOptions<S, F, R, O, D>,
): UploadOperation<S, F, U, R, O, D, A, B> {
    const { auth = 'none' as A, ownership, ...opts } = options;
    return new UploadOperation(endpoint, opts, auth, ownership as B);
}
