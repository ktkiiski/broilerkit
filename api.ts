/* eslint-disable @typescript-eslint/no-explicit-any */
import pick from 'immuton/pick';
import { Key } from 'immuton/types';
import { Client } from './client';
import { ResourceAddition, ResourceRemoval, ResourceUpdate } from './collections';
import { ValidationError } from './errors';
import { HttpMethod } from './http';
import {
    CreateOperation,
    DestroyOperation,
    Operation,
    OperationType,
    UpdateOperation,
    UploadOperation,
} from './operations';
import { OptionalInput, OptionalOutput } from './serializers';
import { Url } from './url';

export interface IntermediateCollection<O> {
    isComplete: boolean;
    items: O[];
}

abstract class BaseApi<O extends Operation<any, any, any, OperationType>> {
    constructor(protected operation: O, protected client: Client) {}

    protected async request(method: HttpMethod, url: Url, payload?: any) {
        const token = await this.getToken();
        const response = await this.client.request(url, method, payload, token);
        const { responseSerializer } = this.operation;
        return responseSerializer ? responseSerializer.deserialize(response.data) : undefined;
    }

    private async getToken(): Promise<string | null> {
        // TODO: Remove this, as the authentication happens with a cookie
        return null;
    }
}

export class CreateApi<
    S,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    B extends U | undefined
> extends BaseApi<CreateOperation<S, U, R, O, D, any, B>> {
    public async post(input: OptionalInput<S, U | R, O, D>): Promise<S> {
        const method = 'POST';
        const { route } = this.operation;
        const payloadSerializer = this.operation.getPayloadSerializer();
        const { resource } = this.operation.endpoint;
        const url = route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const item = await this.request(method, url, payload);
        const resourceIdentity = pick(item, resource.identifyBy);
        const resourceName = resource.name;
        this.client.commitChange({
            type: 'addition',
            resourceName,
            resource: item,
            resourceIdentity,
        });
        return item;
    }
    public async postOptimistically(input: OptionalInput<S, U | R, O, D> & S): Promise<S> {
        const { client, operation } = this;
        const { route } = operation;
        const payloadSerializer = this.operation.getPayloadSerializer();
        const { resource } = operation.endpoint;
        const method = 'POST';
        const url = route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const resource$ = this.request(method, url, payload);
        const resourceIdentity = pick(input as any, resource.identifyBy);
        const resourceName = resource.name;
        const addition: ResourceAddition<S, any> = {
            type: 'addition',
            resource: input,
            resourceName,
            resourceIdentity,
        };
        const unregisterOptimisticAddition = client.registerOptimisticChange(addition);
        try {
            const responseResource = await resource$;
            client.commitChange({
                type: 'addition',
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
        const { route } = this.operation;
        const payloadSerializer = this.operation.getPayloadSerializer();
        return {
            ...route.serializer.validate(input),
            ...payloadSerializer.validate(input),
        } as OptionalOutput<S, U | R, O, D>;
    }
}

export class UpdateApi<
    S,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    B extends U | undefined
> extends BaseApi<UpdateOperation<S, U, R, O, D, any, B>> {
    public put(input: OptionalInput<S, U | R, O, D>): Promise<S> {
        return this.update('PUT', input);
    }
    public validatePut(input: OptionalInput<S, U | R, O, D>): OptionalOutput<S, U | R, O, D> {
        const { operation } = this;
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
        const { operation } = this;
        // TODO: Combine validation errors
        return {
            ...operation.route.serializer.validate(input),
            ...operation.updateSerializer.validate(input),
        } as OptionalInput<S, U, R | O, D>;
    }
    private async update(method: 'PUT' | 'PATCH', input: any): Promise<S> {
        const { client, operation } = this;
        const { resource } = operation.endpoint;
        const payloadSerializer = method === 'PATCH' ? operation.updateSerializer : operation.replaceSerializer;
        const url = operation.route.compile(input);
        const payload = payloadSerializer.serialize(input);
        const idAttributes = resource.identifyBy as (keyof any)[];
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

export class DestroyApi<S, U extends Key<S>, B extends U | undefined> extends BaseApi<DestroyOperation<S, U, any, B>> {
    public async delete(query: Pick<S, U>): Promise<void> {
        const { client, operation } = this;
        const { resource } = operation.endpoint;
        const method = 'DELETE';
        const url = operation.route.compile(query);
        const idAttributes = resource.identifyBy as U[];
        // TODO: Is this necessary? Use `query` instead?
        const resourceIdentity = pick(query, idAttributes) as Pick<S, U>;
        const resourceName = resource.name;
        const removal: ResourceRemoval<S, U> = {
            type: 'removal',
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

export class UploadApi<
    S,
    F extends string,
    U extends Key<S>,
    R extends Key<S>,
    O extends Key<S>,
    D extends Key<S>,
    B extends U | undefined
> extends BaseApi<UploadOperation<S, F, U, R, O, D, any, B>> {
    public async post(input: OptionalInput<S, U | R, O, D> & Record<F, File>): Promise<S> {
        const { operation } = this;
        const method = 'POST';
        const { route } = operation;
        const requestDataSerializer = operation.getPayloadSerializer();
        const { resource } = operation.endpoint;
        const url = route.compile(input);
        // Decode the normal payload for the request
        const payload = requestDataSerializer.encode(input);
        const formData = new FormData();
        Object.keys(payload).forEach((key) => {
            formData.set(key, payload[key]);
        });
        // Add each file
        operation.files.forEach((key) => {
            const file = input[key] as File | undefined;
            if (!file) {
                throw new ValidationError(`Invalid fields`, [
                    {
                        key,
                        message: `Missing file upload`,
                    },
                ]);
            }
            formData.set(key, file);
        });
        const item = await this.request(method, url, formData);
        const resourceIdentity = pick(item, resource.identifyBy);
        const resourceName = resource.name;
        this.client.commitChange({
            type: 'addition',
            resourceName,
            resource: item,
            resourceIdentity,
        });
        return item;
    }
    public validatePost(
        input: OptionalInput<S, U | R, O, D> & Record<F, File>,
    ): OptionalOutput<S, U | R, O, D> & Record<F, File> {
        const { operation } = this;
        const { route } = operation;
        const payloadSerializer = operation.getPayloadSerializer();
        return {
            ...route.serializer.validate(input),
            ...payloadSerializer.validate(input),
        } as OptionalOutput<S, U | R, O, D> & Record<F, File>;
    }
}
