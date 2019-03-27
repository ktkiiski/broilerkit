import { Client } from './client';
import { ResourceAddition, ResourceRemoval, ResourceUpdate } from './collections';
import { HttpMethod, SuccesfulResponse } from './http';
import { shareIterator } from './iteration';
import { CreateOperation, DestroyOperation, ListOperation, Operation, RetrieveOperation, UpdateOperation } from './operations';
import { Cursor, Page } from './pagination';
import { OptionalInput, OptionalOutput } from './serializers';
import { Url } from './url';
import { Key, pick } from './utils/objects';

export type Handler<I, O, D, R> = (input: I, db: D, request: R) => Promise<O>;
export type ResponseHandler<I, O, D, R> = Handler<I, SuccesfulResponse<O>, D, R>;

export interface IntermediateCollection<O> {
    isComplete: boolean;
    items: O[];
}

abstract class BaseApi<T extends Operation<any, any, any>> {
    constructor(
        protected operation: T,
        protected client: Client,
    ) { }

    protected async request(method: HttpMethod, url: Url, payload?: any) {
        const token = await this.getToken();
        const response = await this.client.request(url, method, payload, token);
        const {responseSerializer} = this.operation;
        return responseSerializer ? responseSerializer.deserialize(response.data) : undefined;
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
        return this.request('GET', url);
    }
    public validateGet(input: Pick<S, U>): Pick<S, U> {
        return this.operation.route.serializer.validate(input);
    }
}

export class ListApi<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B extends U | undefined>
extends BaseApi<ListOperation<S, U, O, F, any, B>> {
    public getPage(input: Cursor<S, U, O, F>): Promise<Page<S, Cursor<S, U, O, F>>> {
        const url = this.operation.route.compile(input);
        return this.request('GET', url);
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
}

export class CreateApi<S, U extends Key<S>, R extends Key<S>, O extends Key<S>, D extends Key<S>, B extends U | undefined>
extends BaseApi<CreateOperation<S, U, R, O, D, any, B>> {
    public async post(input: OptionalInput<S, U | R, O, D>): Promise<S> {
        const method = 'POST';
        const {route, payloadSerializer} = this.operation;
        const {resource} = this.operation.endpoint;
        const url = route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const item = await this.request(method, url, payload);
        const resourceIdentity = pick(item, resource.identifyBy);
        const resourceName = resource.name;
        this.client.commitChange({
            type: 'addition',
            collectionUrl: url.path,
            resourceName,
            resource: item,
            resourceIdentity,
        });
        return item;
    }
    public async postOptimistically(input: OptionalInput<S, U | R, O, D> & S): Promise<S> {
        const {client, operation} = this;
        const {route, payloadSerializer} = operation;
        const {resource} = operation.endpoint;
        const method = 'POST';
        const url = route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const resource$ = this.request(method, url, payload);
        const resourceIdentity = pick(input as any, resource.identifyBy);
        const resourceName = resource.name;
        const addition: ResourceAddition<S, any> = {
            type: 'addition',
            collectionUrl: url.path,
            resource: input,
            resourceName,
            resourceIdentity,
        };
        const unregisterOptimisticAddition = client.registerOptimisticChange(addition);
        try {
            const responseResource = await resource$;
            client.commitChange({
                type: 'addition',
                collectionUrl: url.path,
                resource: responseResource,
                resourceName,
                resourceIdentity,
            });
            return responseResource;
        } finally {
            unregisterOptimisticAddition();
        }
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
        const update: ResourceUpdate<S, U> = {
            type: 'update',
            resourceName,
            resource: input,
            resourceIdentity,
        };
        const request = this.request(method, url, payload);
        const unregisterOptimisticUpdate = client.registerOptimisticChange(update);
        try {
            const responseResource = await request;
            client.commitChange({
                type: 'update',
                resourceName,
                resource: responseResource,
                resourceIdentity,
            });
            return responseResource;
        } finally {
            unregisterOptimisticUpdate();
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
        // TODO: Is this necessary? Use `query` instead?
        const resourceIdentity = pick(query, idAttributes) as Pick<S, U>;
        const resourceName = resource.name;
        const removal: ResourceRemoval<S, U> = {
            type: 'removal',
            resourceUrl: url.path,
            resourceName,
            resourceIdentity,
        };
        const request = this.request(method, url);
        const unregisterOptimisticRemoval = client.registerOptimisticChange(removal);
        try {
            await request;
            client.commitChange(removal);
        } finally {
            unregisterOptimisticRemoval();
        }
    }
}
