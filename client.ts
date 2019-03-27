import { ajax } from './ajax';
import { AuthClient } from './auth';
import { ResourceChange } from './collections';
import { ApiResponse, HttpMethod, isErrorResponse, NotImplemented } from './http';
import { ListOperation, Operation, RetrieveOperation } from './operations';
import { Cursor } from './pagination';
import { Url } from './url';
import { getOrderedIndex } from './utils/arrays';
import { hasProperties } from './utils/compare';
import { Key, keys } from './utils/objects';

export interface Retrieval<S = any, U extends Key<S> = any> {
    operation: RetrieveOperation<S, U, any, any>;
    input: Pick<S, U>;
}

export interface Listing<S = any, U extends Key<S> = any, O extends Key<S> = any, F extends Key<S> = any> {
    operation: ListOperation<S, U, O, F, any, any>;
    input: Cursor<S, U, O, F>;
}

export type ResourceCache = Record<string, Record<string, ResourceState> | undefined>;
export type CollectionCache = Record<string, Record<string, CollectionState> | undefined>;

export interface Client {
    resourceCache: ResourceCache;
    collectionCache: CollectionCache;
    readonly authClient?: AuthClient | null;
    request(url: Url, method: HttpMethod, payload: any | null, token: string | null): Promise<ApiResponse>;
    inquiryResource<S, U extends Key<S>>(op: RetrieveOperation<S, U, any, any>, input: Pick<S, U>): ResourceState<S>;
    subscribeResourceChanges<S, U extends Key<S>>(op: RetrieveOperation<S, U, any, any>, input: Pick<S, U>, callback: (state: ResourceState<S>) => void): () => void;
    inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>): CollectionState;
    subscribeCollectionChanges<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>, minCount: number, listener: (collection: CollectionState) => void): () => void;
    registerOptimisticChange(change: ResourceChange<any, any>): () => void;
    commitChange(change: ResourceChange<any, any>): void;
}

export interface ResourceState<T = any> {
    resource: T | null;
    error: any | null; // TODO: More specific error type!
    isLoading: boolean;
}

export interface CollectionState<S = any> {
    resources: S[];
    error: any | null; // TODO: More specific error type!
    isLoading: boolean;
    isComplete: boolean;
    count: number;
    ordering: keyof S;
    direction: 'asc' | 'desc';
}

interface CollectionListener {
    resourceName: string;
    callback: (collection: CollectionState) => void;
    minCount: number;
}

interface ResourceListener {
    resourceName: string;
    callback: (resource: ResourceState) => void;
}

const doNothing = () => { /* Does nothing */ };

abstract class BaseClient implements Client {
    public abstract authClient?: AuthClient | null;

    private optimisticChanges: Array<ResourceChange<any, any>> = [];
    private resourceListeners: ListMapping<ResourceListener> = {};
    private collectionListeners: ListMapping<CollectionListener> = {};

    constructor(
        public resourceCache: ResourceCache = {},
        public collectionCache: CollectionCache = {},
    ) {}

    public inquiryResource<S, U extends Key<S>>(op: RetrieveOperation<S, U, any, any>, input: Pick<S, U>): ResourceState<S> {
        return this.initResourceState(op, input)[1];
    }

    public subscribeResourceChanges<S, U extends Key<S>>(op: RetrieveOperation<S, U, any, any>, input: Pick<S, U>, fn: (state: ResourceState<S>) => void): () => void {
        // Wrap to a async function that prevents errors being passed through!
        const callback = wrapCallback(fn);
        const [url, initialState] = this.initResourceState(op, input);
        callback(initialState);
        if (!url) {
            return doNothing;
        }
        const unsubscribe = addToMapping(this.resourceListeners, url.toString(), {
            callback,
            resourceName: op.endpoint.resource.name,
        });
        // Ensure that the resource is being loaded
        this.loadResource(url, op);
        return unsubscribe;
    }

    public inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>): CollectionState {
        return this.initCollectionState(op, input)[1];
    }

    public subscribeCollectionChanges<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>, minCount: number, fn: (collection: CollectionState) => void): () => void {
        // Wrap to a async function that prevents errors being passed through!
        const callback = wrapCallback(fn);
        const [url, initialState] = this.initCollectionState(op, input);
        callback(initialState);
        if (!url) {
            return doNothing;
        }
        const unsubscribe = addToMapping(this.collectionListeners, url.toString(), {
            callback,
            minCount,
            resourceName: op.endpoint.resource.name,
        });
        // Ensure that the collection is being loaded.
        // This needs to be after registering the listener.
        this.loadCollection(url, op, input);
        return unsubscribe;
    }

    public registerOptimisticChange(change: ResourceChange<any, any>): () => void {
        const {optimisticChanges} = this;
        optimisticChanges.push(change);
        // TODO: Optimize by avoid triggered non-related listeners
        if (change.type === 'update') {
            this.triggerResourceByName(change.resourceName);
        }
        this.triggerCollectionByName(change.resourceName);
        return () => {
            const index = optimisticChanges.indexOf(change);
            if (index >= 0) {
                optimisticChanges.splice(index, 1);
            }
            if (change.type === 'update') {
                this.triggerResourceByName(change.resourceName);
            }
            this.triggerCollectionByName(change.resourceName);
        };
    }

    public commitChange(change: ResourceChange<any, any>): void {
        const {resourceName} = change;
        const collectionsByUrl = this.collectionCache[resourceName];
        const resourcesByUrl = this.resourceCache[resourceName];
        const changedResourceUrls: string[] = [];
        const changedCollectionUrls: string[] = [];
        // Apply to resources
        if (resourcesByUrl && change.type === 'update') {
            for (const url of Object.keys(resourcesByUrl)) {
                const oldState = resourcesByUrl[url];
                const newState = applyChangeToResource(oldState, change);
                if (newState !== oldState) {
                    resourcesByUrl[url] = newState;
                    changedResourceUrls.push(url);
                }
            }
        }
        // Apply to collections
        if (collectionsByUrl) {
            for (const url of Object.keys(collectionsByUrl)) {
                const oldState = collectionsByUrl[url];
                const newState = applyChangeToCollection(oldState, change);
                if (newState !== oldState) {
                    collectionsByUrl[url] = newState;
                    changedCollectionUrls.push(url);
                }
            }
        }
        for (const url of changedResourceUrls) {
            this.triggerResourceUrl(resourceName, url);
        }
        for (const url of changedCollectionUrls) {
            this.triggerCollectionUrl(resourceName, url);
        }
    }

    public abstract request(url: Url, method: HttpMethod, payload: any | null, token: string | null): Promise<ApiResponse>;

    private async getToken(operation: Operation<any, any, any>): Promise<string | null> {
        const {authClient} = this;
        const {authType} = operation;
        if (authType === 'none') {
            // No authentication required, but return the token if available
            return authClient && authClient.getIdToken() || null;
        } else if (authClient) {
            // Authentication required, so demand a token
            // TODO: Handle errors!
            return await authClient.demandIdToken();
        }
        // Authentication required but no auth client defined
        throw new Error(`API endpoint requires authentication but no authentication client is defined.`);
    }

    private setResourceState(resourceName: string, url: string, state: ResourceState): boolean {
        const resourcesByUrl = this.resourceCache[resourceName] || {};
        if (resourcesByUrl[url] === state) {
            return false;
        }
        resourcesByUrl[url] = state;
        this.resourceCache[resourceName] = resourcesByUrl;
        this.triggerResourceUrl(resourceName, url);
        return true;
    }

    private setCollectionState(resourceName: string, url: string, state: CollectionState): boolean {
        const collectionsByUrl = this.collectionCache[resourceName] || {};
        if (collectionsByUrl[url] === state) {
            return false;
        }
        collectionsByUrl[url] = state;
        this.collectionCache[resourceName] = collectionsByUrl;
        this.triggerCollectionUrl(resourceName, url);
        return true;
    }

    private triggerResourceUrl(resourceName: string, url: string) {
        const listeners = this.resourceListeners[url];
        if (!listeners) {
            return;
        }
        const state = this.getResourceState(resourceName, url);
        if (state) {
            for (const listener of listeners) {
                if (listener.resourceName === resourceName) {
                    listener.callback(state);
                }
            }
        }
    }

    private triggerCollectionUrl(resourceName: string, url: string) {
        const listeners = this.collectionListeners[url];
        if (!listeners) {
            return;
        }
        const state = this.getCollectionState(resourceName, url);
        if (state) {
            for (const listener of listeners) {
                if (listener.resourceName === resourceName) {
                    listener.callback(state);
                }
            }
        }
    }

    private triggerResourceByName(resourceName: string) {
        const {resourceListeners} = this;
        for (const url of keys(resourceListeners)) {
            this.triggerResourceUrl(resourceName, url);
        }
    }

    private triggerCollectionByName(resourceName: string) {
        const {collectionListeners} = this;
        for (const url of keys(collectionListeners)) {
            this.triggerCollectionUrl(resourceName, url);
        }
    }

    private initResourceState<S, U extends Key<S>>(op: RetrieveOperation<S, U, any, any>, input: Pick<S, U>): [Url | null, ResourceState<S>] {
        const resourceName = op.endpoint.resource.name;
        try {
            const url = op.route.compile(input);
            const state = this.getResourceState(resourceName, url.toString());
            return [url, state || {
                resource: null,
                isLoading: false,
                error: null,
            }];
        } catch (error) {
            if (!isErrorResponse(error)) {
                throw error;
            }
            return [null, {
                resource: null,
                isLoading: false,
                error,
            }];
        }
    }
    private initCollectionState<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>): [Url | null, CollectionState] {
        const resourceName = op.endpoint.resource.name;
        try {
            const url = op.route.compile(input);
            const state = this.getCollectionState(resourceName, url.toString());
            return [url, state || {
                resources: [],
                isLoading: false,
                isComplete: false,
                error: null,
                count: 0,
                ordering: input.ordering,
                direction: input.direction,
            }];
        } catch (error) {
            if (!isErrorResponse(error)) {
                throw error;
            }
            return [null, {
                resources: [],
                isLoading: false,
                isComplete: false,
                error,
                count: 0,
                ordering: input.ordering,
                direction: input.direction,
            }];
        }
    }
    private getResourceState(resourceName: string, url: string): ResourceState | null {
        const resourcesByUrl = this.resourceCache[resourceName];
        const state = resourcesByUrl && resourcesByUrl[url];
        if (!state) {
            return null;
        }
        // Apply optimistic changes
        return this.optimisticChanges
            .filter((change) => change.resourceName === resourceName)
            .reduce(
                (result, change) => applyChangeToResource(result, change), state,
            )
        ;
    }

    private getCollectionState(resourceName: string, url: string): CollectionState | null {
        const collectionsByUrl = this.collectionCache[resourceName];
        const state = collectionsByUrl && collectionsByUrl[url];
        if (!state) {
            return null;
        }
        // Apply optimistic changes
        return this.optimisticChanges
            .filter((change) => change.resourceName === resourceName)
            .reduce(
                (result, change) => applyChangeToCollection(result, change), state,
            )
        ;
    }

    private async loadResource<S, U extends Key<S>>(url: Url, op: RetrieveOperation<S, U, any, any>) {
        const resourceName = op.endpoint.resource.name;
        const resourcesByUrl = this.resourceCache[resourceName];
        const resourceUrl = url.toString();
        const currentState = resourcesByUrl && resourcesByUrl[resourceUrl] as ResourceState<S> | undefined;
        if (currentState && (currentState.isLoading || currentState.resource)) {
            // Already loading or loaded
            return;
        }
        // Set the collection to the loading state
        let state: ResourceState<S> = {
            error: null,
            resource: null, // Don't reset previous properties
            ...currentState,
            isLoading: true,
        };
        this.setResourceState(resourceName, resourceUrl, state);
        try {
            const token = await this.getToken(op);
            const response = await this.request(url, 'GET', null, token);
            const resource = op.responseSerializer.deserialize(response.data);
            state = { ...state, error: null, resource };
            this.setResourceState(resourceName, resourceUrl, state);
        } catch (error) {
            // Set the error to the state
            state = { ...state, error };
            this.setResourceState(resourceName, resourceUrl, state);
        } finally {
            // Set the collection not loading any more
            state = { ...state, isLoading: false };
            this.setResourceState(resourceName, resourceUrl, state);
        }
    }

    private async loadCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(url: Url, op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>) {
        const resourceName = op.endpoint.resource.name;
        const collectionsByUrl = this.collectionCache[resourceName] || {};
        const collectionUrl = url.toString();
        const currentState = collectionsByUrl[collectionUrl] as CollectionState<S> | undefined;
        if (currentState && (currentState.isLoading || currentState.isComplete)) {
            // Already loading or loaded
            return;
        }
        // Set the collection to the loading state
        let loadedResources: S[] = [];
        let state: CollectionState<S> = {
            error: null,
            ...currentState,
            resources: loadedResources,
            count: loadedResources.length,
            isComplete: false,
            isLoading: true,
            ordering: input.ordering,
            direction: input.direction,
        };
        this.setCollectionState(resourceName, collectionUrl, state);
        try {
            let nextUrl: Url | null = url;
            while (nextUrl) {
                // Ensure that there are listeners
                const listeners = this.collectionListeners[collectionUrl];
                if (!listeners || listeners.every(({minCount}) => minCount <= state.count)) {
                    // No one is interested (any more)
                    break;
                }
                const token = await this.getToken(op);
                const response = await this.request(nextUrl, 'GET', null, token);
                const {next, results} = op.responseSerializer.deserialize(response.data);
                // Add loaded results to the resources
                // TODO: Prevent duplicates!!!
                loadedResources = loadedResources.concat(results);
                state = {
                    ...state,
                    error: null,
                    resources: loadedResources,
                    count: loadedResources.length,
                    isComplete: !next,
                };
                this.setCollectionState(resourceName, collectionUrl, state);
                nextUrl = next && op.route.compile(next);
            }
        } catch (error) {
            // Set the error to the state
            state = {...state, error};
            this.setCollectionState(resourceName, collectionUrl, state);
        } finally {
            // Set the collection not loading any more
            state = {...state, isLoading: false};
            this.setCollectionState(resourceName, collectionUrl, state);
        }
    }
}

/**
 * Provides the caching and streaming functionality
 * for the client-side API usage.
 */
export class BrowserClient extends BaseClient implements Client {
    constructor(
        public readonly apiRoot: string,
        public readonly authClient?: AuthClient | null,
        resourceCache: ResourceCache = {},
        collectionCache: CollectionCache = {},
    ) {
        super(resourceCache, collectionCache);
    }

    public async request(url: Url, method: HttpMethod, payload: any | null, token: string | null) {
        const headers: Record<string, string> = token ? {Authorization: `Bearer ${token}`} : {};
        return await ajax({
            url: `${this.apiRoot}${url}`,
            method, payload, headers,
        });
    }

    /**
     * Clears those resources and collections from the cache that
     * no longer have subscribers.
     */
    public flushCache(): void {
        // TODO
    }
}

export class DummyClient extends BaseClient implements Client {
    public authClient: undefined;
    constructor(
        private readonly retrievals: Retrieval[] | null,
        private readonly listings: Listing[] | null,
        resourceCache: ResourceCache,
        collectionCache: CollectionCache,
    ) {
        super(resourceCache, collectionCache);
    }
    public request(): never {
        throw new NotImplemented(`No client defined`);
    }

    public inquiryResource<S, U extends Key<S>>(operation: RetrieveOperation<S, U, any, any>, input: Pick<S, U>) {
        const result = super.inquiryResource(operation, input);
        if (this.retrievals) {
            this.retrievals.push({operation, input});
        }
        return result;
    }

    public inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(operation: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>) {
        const result = super.inquiryCollection(operation, input);
        if (this.listings) {
            this.listings.push({operation, input});
        }
        return result;
    }
}

export interface Bindable<T> {
    bind(client: Client): T;
}

function applyChangeToResource<T>(state: ResourceState<T>, change: ResourceChange<any, any>): ResourceState<T> {
    const {resource} = state;
    if (!resource || change.type !== 'update' || !hasProperties(resource, change.resourceIdentity)) {
        return state;
    }
    return {
        ...state,
        resource: { ...resource, ...change.resource },
    };
}

function applyChangeToCollection<T>(state: CollectionState<T>, change: ResourceChange<any, any>): CollectionState<T> {
    const isChangedResource = (item: any) => hasProperties(item, change.resourceIdentity, 0);
    if (change.type === 'removal') {
        // Filter out any matching resource from the collection
        const resources = without(state.resources, isChangedResource);
        if (state.resources !== resources) {
            return { ...state, resources };
        }
    } else if (change.type === 'addition') {
        // Ensure that the item won't show up from the original collection
        const resources = without(state.resources, isChangedResource);
        // Add a new resource to the corresponding position, according to the ordering
        const sortedIndex = getOrderedIndex(
            resources, change.resource,
            state.ordering,
            state.direction,
        );
        // If added at the end of the collection, then add only if complete or loading
        if (sortedIndex < resources.length || state.isComplete || state.isLoading) {
            resources.splice(sortedIndex, 0, change.resource);
            return { ...state, resources };
        }
    } else if (change.type === 'update') {
        // Apply the update to the matching resource
        const resources = imap(state.resources, (resource) => {
            if (isChangedResource(resource)) {
                return { ...resource, ...change.resource };
            }
            return resource;
        });
        if (state.resources !== resources) {
            return { ...state, resources };
        }
    }
    return state;
}

function without<T>(array: T[], cb: (value: T) => boolean) {
    const index = array.findIndex(cb);
    if (index < 0) {
        return array;
    }
    array = array.slice();
    array.splice(index, 1);
    return array;
}

function imap<T>(array: T[], cb: (value: T) => T): T[] {
    let counter = 0;
    const result = array.map((value) => {
        const newValue = cb(value);
        if (newValue !== value) {
            counter ++;
        }
        return newValue;
    });
    return counter > 0 ? result : array;
}

type ListMapping<T> = Record<string, T[]>;

function addToMapping<T>(mapping: ListMapping<T>, key: string, value: T): () => void {
    const list = mapping[key] || [];
    list.push(value);
    mapping[key] = list;
    return () => {
        removeFromMapping(mapping, key, value);
    };
}

function removeFromMapping<T>(mapping: ListMapping<T>, key: string, value: T): boolean {
    const list = mapping[key];
    if (list) {
        const index = list.indexOf(value);
        if (index >= 0) {
            list.slice(index, 1);
            if (!list.length) {
                delete mapping[key];
            }
            return true;
        }
    }
    return false;
}

function wrapCallback<T>(fn: (arg: T) => any) {
    async function callback(arg: T) {
        await fn(arg);
    }
    return callback;
}
