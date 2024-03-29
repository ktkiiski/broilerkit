/* eslint-disable no-continue */
/* eslint-disable @typescript-eslint/no-explicit-any */
import filter from 'immuton/filter';
import findOrderedIndex from 'immuton/findOrderedIndex';
import hasProperties from 'immuton/hasProperties';
import isEqual from 'immuton/isEqual';
import mapFilter from 'immuton/mapFilter';
import pick from 'immuton/pick';
import set from 'immuton/set';
import splice from 'immuton/splice';
import type { Key } from 'immuton/types';
import { ajax, ajaxJson } from './ajax';
import { wait } from './async';
import type { AuthClient, DummyAuthClient } from './auth';
import {
    ResourceAddition,
    ResourceChange,
    ResourceRemoval,
    getNewState,
    getChangeDelta,
    deserializeResourceChange,
} from './changes';
import { ApiResponse, HttpMethod, HttpStatus, isErrorResponse, isResponse, NotImplemented } from './http';
import { keys } from './objects';
import type { AuthenticationType, ListOperation, RetrieveOperation } from './operations';
import type { Cursor } from './pagination';
import type { Resource } from './resources';
import { UploadForm, uploadSerializer } from './uploads';
import type { Url } from './url';

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
    upload(file: File, upload: UploadForm): Promise<void>;
    inquiryResource<S, U extends Key<S>>(op: RetrieveOperation<S, U, any, any>, input: Pick<S, U>): ResourceState<S>;
    subscribeResourceChanges<S, U extends Key<S>>(
        op: RetrieveOperation<S, U, any, any>,
        input: Pick<S, U>,
        callback: (state: ResourceState<S>) => void,
    ): () => void;
    inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        op: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
    ): CollectionState<S>;
    subscribeCollectionChanges<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        op: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
        minCount: number,
        listener: (collection: CollectionState) => void,
    ): () => void;
    registerOptimisticChange(change: ResourceChange<any, any>): () => void;
    commitChange(change: ResourceChange<any, any>): void;
    refreshAll(): Promise<void>;
    generateUniqueId(): number;
}

export interface ResourceState<T = any> {
    resource: T | null;
    error: any | null; // TODO: More specific error type!
    isLoading: boolean;
    isLoaded: boolean;
}

export interface CollectionState<S = any> {
    filters: Partial<S>;
    resources: S[];
    error: any | null; // TODO: More specific error type!
    isLoading: boolean;
    isComplete: boolean;
    isLoaded: boolean;
    count: number;
    ordering: keyof S;
    direction: 'asc' | 'desc';
}

interface CollectionListener {
    resource: Resource<any, any, any>;
    url: Url;
    op: ListOperation<any, any, any, any, any, any>;
    input: Cursor<any, any, any, any>;
    callback: (collection: CollectionState) => void;
    minCount: number;
}

interface ResourceListener {
    url: Url;
    op: RetrieveOperation<any, any, any, any>;
    resource: Resource<any, any, any>;
    callback: (resource: ResourceState) => void;
}

const doNothing = () => {
    /* Does nothing */
};

abstract class BaseClient implements Client {
    protected resourceListeners: ListMapping<ResourceListener> = {};

    protected collectionListeners: ListMapping<CollectionListener> = {};

    private pendingLoads = new Set<string>();

    private runningLoads = new Map<string, Promise<any>>();

    private optimisticChanges: ResourceChange<any, any>[] = [];

    private uniqueIdCounter = 0;

    constructor(public resourceCache: ResourceCache = {}, public collectionCache: CollectionCache = {}) {}

    public inquiryResource<S, U extends Key<S>>(
        op: RetrieveOperation<S, U, any, any>,
        input: Pick<S, U>,
    ): ResourceState<S> {
        return this.initResourceState(op, input)[1];
    }

    public subscribeResourceChanges<S, U extends Key<S>>(
        op: RetrieveOperation<S, U, any, any>,
        input: Pick<S, U>,
        fn: (state: ResourceState<S>) => void,
    ): () => void {
        // Wrap to a async function that prevents errors being passed through!
        const callback = wrapCallback(fn);
        const [url, initialState] = this.initResourceState(op, input);
        callback(initialState);
        if (!url) {
            return doNothing;
        }
        const resourceUrl = url.toString();
        const { resource } = op.endpoint;
        const unsubscribe = addToMapping(this.resourceListeners, resourceUrl, {
            url,
            op,
            callback,
            resource,
        });
        // If the resource has not yet been loaded, then ensure that it will be
        const state = this.getRealResourceState(resource.name, resourceUrl);
        if (!state || !(state.isLoading || state.isLoaded)) {
            this.loadResource(url, op);
        }
        // Resource needs to be reloaded when becoming online
        const onOnline = () => this.loadResource(url, op);
        window.addEventListener('online', onOnline);
        return () => {
            window.removeEventListener('online', onOnline);
            unsubscribe();
        };
    }

    public inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        op: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
    ): CollectionState<S> {
        return this.initCollectionState(op, input)[1];
    }

    public subscribeCollectionChanges<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        op: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
        minCount: number,
        fn: (collection: CollectionState) => void,
    ): () => void {
        // Wrap to a async function that prevents errors being passed through!
        const callback = wrapCallback(fn);
        const [url, initialState] = this.initCollectionState(op, input);
        callback(initialState);
        if (!url) {
            return doNothing;
        }
        const collectionUrl = url.toString();
        const { resource } = op.endpoint;
        const unsubscribe = addToMapping(this.collectionListeners, collectionUrl, {
            op,
            url,
            input,
            callback,
            minCount,
            resource: op.endpoint.resource,
        });
        // If the collection has not yet been loaded, then ensure that it will be
        const state = this.getRealCollectionState(resource.name, collectionUrl);
        if (!state || !(state.isLoading || state.isLoaded)) {
            // Ensure that the collection is being loaded.
            // This needs to be after registering the listener.
            this.loadCollection(url, op, input);
        }
        // Collection needs to be reloaded when becoming online
        const onOnline = () => this.loadCollection(url, op, input);
        window.addEventListener('online', onOnline);
        return () => {
            window.removeEventListener('online', onOnline);
            unsubscribe();
        };
    }

    public registerOptimisticChange(change: ResourceChange<any, any>): () => void {
        const { optimisticChanges } = this;
        optimisticChanges.push(change);
        // TODO: Optimize by avoid triggered non-related listeners
        if (change.type === 'update') {
            this.triggerResourceByName(change.name);
        }
        this.triggerCollectionByName(change.name);
        return () => {
            const index = optimisticChanges.indexOf(change);
            if (index >= 0) {
                optimisticChanges.splice(index, 1);
            }
            if (change.type === 'update') {
                this.triggerResourceByName(change.name);
            }
            this.triggerCollectionByName(change.name);
        };
    }

    public commitChange(change: ResourceChange<any, any>): void {
        const { name: resourceName } = change;
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
                if (newState == null) {
                    // Re-load required
                    this.loadCollectionByUrl(url);
                } else if (newState !== oldState) {
                    collectionsByUrl[url] = newState;
                    changedCollectionUrls.push(url);
                }
            }
        }
        this.triggerResourceUrls(resourceName, changedResourceUrls);
        this.triggerCollectionUrls(resourceName, changedCollectionUrls);
    }

    public generateUniqueId(): number {
        this.uniqueIdCounter += 1;
        return this.uniqueIdCounter;
    }

    public async refreshAll(): Promise<void> {
        const { resourceListeners, collectionListeners } = this;
        const promises: Promise<void>[] = [];
        Object.keys(resourceListeners).forEach((resourceUrl) => {
            for (const { url, op } of resourceListeners[resourceUrl]) {
                promises.push(this.loadResource(url, op));
            }
        });
        Object.keys(collectionListeners).forEach((collectionUrl) => {
            for (const { url, op, input } of collectionListeners[collectionUrl]) {
                promises.push(this.loadCollection(url, op, input));
            }
        });
        await Promise.all(promises.map((promise) => promise.catch(doNothing)));
    }

    public abstract request(
        url: Url,
        method: HttpMethod,
        payload: any | null,
        token: string | null,
    ): Promise<ApiResponse>;

    public abstract upload(file: File, upload: UploadForm): Promise<void>;

    protected applySerializedChanges(serializedChanges: unknown[]) {
        const changedResourceUrlsByName: ListMapping<string> = {};
        const changedCollectionUrlsByName: ListMapping<string> = {};
        const { resourceListeners, collectionListeners } = this;
        const resourceListenerUrls = keys(resourceListeners);
        const collectionListenerUrls = keys(collectionListeners);
        for (const serializedChange of serializedChanges) {
            // Apply changes to resource states
            for (const url of resourceListenerUrls) {
                const listeners = resourceListeners[url];
                for (const listener of listeners) {
                    const { resource } = listener;
                    const resourceName = resource.name;
                    const resourcesByUrl = this.resourceCache[resourceName];
                    const oldState = resourcesByUrl && resourcesByUrl[url];
                    if (resourcesByUrl && oldState && oldState.resource) {
                        let change;
                        try {
                            change = deserializeResourceChange(serializedChange, resource);
                            if (!change) {
                                continue;
                            }
                        } catch (error) {
                            // eslint-disable-next-line no-console
                            console.warn('Failed to deserialize a change:', error);
                            continue;
                        }
                        const newState = applyChangeToResource(oldState, change);
                        if (newState == null) {
                            this.loadResource(listener.url, listener.op);
                        } else if (newState !== oldState) {
                            resourcesByUrl[url] = newState;
                            addToMapping(changedResourceUrlsByName, resourceName, url);
                        }
                    }
                    // We only need to process the first listener, as all the listeners
                    // share the state and resource type
                    break;
                }
            }
            // Apply states to collection states
            for (const url of collectionListenerUrls) {
                const listeners = collectionListeners[url];
                for (const listener of listeners) {
                    const { resource } = listener;
                    const resourceName = resource.name;
                    const collectionsByUrl = this.collectionCache[resourceName];
                    const oldState = collectionsByUrl && collectionsByUrl[url];
                    if (collectionsByUrl && oldState) {
                        let change;
                        try {
                            change = deserializeResourceChange(serializedChange, resource);
                            if (!change) {
                                continue;
                            }
                        } catch (error) {
                            // eslint-disable-next-line no-console
                            console.warn('Failed to deserialize a change:', error);
                            continue;
                        }
                        // Apply state change to the collection
                        const newState = applyChangeToCollection(oldState, change);
                        if (newState == null) {
                            this.loadCollection(listener.url, listener.op, listener.input);
                        } else if (newState !== oldState) {
                            collectionsByUrl[url] = newState;
                            addToMapping(changedCollectionUrlsByName, resourceName, url);
                        }
                    }
                    // We only need to process the first listener, as all the listeners
                    // share the state and resource type
                    break;
                }
            }
        }

        // Trigger listeners for affected resource URLs
        for (const resourceName of keys(changedResourceUrlsByName)) {
            this.triggerResourceUrls(resourceName, changedResourceUrlsByName[resourceName]);
        }
        for (const resourceName of keys(changedCollectionUrlsByName)) {
            this.triggerCollectionUrls(resourceName, changedCollectionUrlsByName[resourceName]);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private async getToken(_: AuthenticationType): Promise<string | null> {
        // TODO: Remove this, as the authentication happens with a cookie
        return null;
    }

    private setResourceState(resourceName: string, url: string, state: ResourceState): boolean {
        const resourcesByUrl = this.resourceCache[resourceName] || {};
        if (resourcesByUrl[url] === state) {
            return false;
        }
        resourcesByUrl[url] = state;
        this.resourceCache[resourceName] = resourcesByUrl;
        this.triggerResourceUrl(resourceName, url);
        return true;
    }

    private setCollectionState(resourceName: string, url: string, state: CollectionState): boolean {
        const collectionsByUrl = this.collectionCache[resourceName] || {};
        if (collectionsByUrl[url] === state) {
            return false;
        }
        collectionsByUrl[url] = state;
        this.collectionCache[resourceName] = collectionsByUrl;
        this.triggerCollectionUrl(resourceName, url);
        return true;
    }

    private triggerResourceUrls(resourceName: string, urls: string[]) {
        for (const url of urls) {
            this.triggerResourceUrl(resourceName, url);
        }
    }

    private triggerResourceUrl(resourceName: string, url: string) {
        const listeners = this.resourceListeners[url];
        if (!listeners) {
            return;
        }
        const state = this.getResourceState(resourceName, url);
        if (state) {
            for (const listener of listeners) {
                if (listener.resource.name === resourceName) {
                    listener.callback(state);
                }
            }
        }
    }

    private triggerCollectionUrls(resourceName: string, urls: string[]) {
        for (const url of urls) {
            this.triggerCollectionUrl(resourceName, url);
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
                if (listener.resource.name === resourceName) {
                    listener.callback(state);
                }
            }
        }
    }

    private triggerResourceByName(resourceName: string) {
        const { resourceListeners } = this;
        this.triggerResourceUrls(resourceName, keys(resourceListeners));
    }

    private triggerCollectionByName(resourceName: string) {
        const { collectionListeners } = this;
        this.triggerCollectionUrls(resourceName, keys(collectionListeners));
    }

    private initResourceState<S, U extends Key<S>>(
        op: RetrieveOperation<S, U, any, any>,
        input: Pick<S, U>,
    ): [Url | null, ResourceState<S>] {
        const resourceName = op.endpoint.resource.name;
        try {
            const url = op.route.compile(input);
            const state = this.getResourceState(resourceName, url.toString());
            return [
                url,
                state || {
                    resource: null,
                    isLoading: false,
                    isLoaded: false,
                    error: null,
                },
            ];
        } catch (error) {
            if (!isErrorResponse(error)) {
                throw error;
            }
            return [
                null,
                {
                    resource: null,
                    isLoading: false,
                    isLoaded: false,
                    error,
                },
            ];
        }
    }

    private initCollectionState<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        op: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
    ): [Url | null, CollectionState<S>] {
        const { ordering, direction, since, ...filters } = input;
        const resourceName = op.endpoint.resource.name;
        try {
            const url = op.route.compile(input);
            const state = this.getCollectionState(resourceName, url.toString());
            return [
                url,
                state || {
                    resources: [],
                    isLoading: false,
                    isComplete: false,
                    isLoaded: false,
                    error: null,
                    count: 0,
                    ordering,
                    direction,
                    filters: filters as any,
                },
            ];
        } catch (error) {
            if (!isErrorResponse(error)) {
                throw error;
            }
            return [
                null,
                {
                    resources: [],
                    isLoading: false,
                    isComplete: false,
                    isLoaded: false,
                    error,
                    count: 0,
                    ordering,
                    direction,
                    filters: filters as any,
                },
            ];
        }
    }

    private getRealResourceState(resourceName: string, url: string): ResourceState | null {
        const resourcesByUrl = this.resourceCache[resourceName];
        return (resourcesByUrl && resourcesByUrl[url]) || null;
    }

    private getResourceState(resourceName: string, url: string): ResourceState | null {
        const state = this.getRealResourceState(resourceName, url);
        if (!state) {
            return null;
        }
        // Apply optimistic changes
        return this.optimisticChanges
            .filter((change) => change.name === resourceName)
            .reduce((result, change) => applyChangeToResource(result, change), state);
    }

    private getRealCollectionState(resourceName: string, url: string): CollectionState | null {
        const collectionsByUrl = this.collectionCache[resourceName];
        return (collectionsByUrl && collectionsByUrl[url]) || null;
    }

    private getCollectionState(resourceName: string, url: string): CollectionState | null {
        const state = this.getRealCollectionState(resourceName, url);
        if (!state) {
            return null;
        }
        // Apply optimistic changes
        return this.optimisticChanges
            .filter((change) => change.name === resourceName)
            .reduce((result, change) => applyChangeToCollection(result, change) || result, state);
    }

    private async loadCollectionByUrl(url: string): Promise<void> {
        const listeners = this.collectionListeners[url];
        if (listeners) {
            // eslint-disable-next-line no-unreachable-loop
            for (const listener of listeners) {
                await this.loadCollection(listener.url, listener.op, listener.input);
                break;
            }
        }
    }

    private async loadResource<S, U extends Key<S>>(url: Url, op: RetrieveOperation<S, U, any, any>): Promise<void> {
        return this.requestLoad(url.toString(), () => this.requestResource(url, op));
    }

    private async loadCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        url: Url,
        op: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
    ): Promise<void> {
        return this.requestLoad(url.toString(), () => this.requestCollection(url, op, input));
    }

    private async requestLoad<S>(url: string, startRequest: () => Promise<S>): Promise<S> {
        const { runningLoads, pendingLoads } = this;
        // Is already loading?
        const load = runningLoads.get(url);
        if (!load) {
            // Not yet loading. Mark pending
            pendingLoads.add(url);
            // Start loading
            const newLoad = startRequest().finally(() => {
                if (runningLoads.get(url) === newLoad) {
                    runningLoads.delete(url);
                }
            });
            runningLoads.set(url, newLoad);
            return newLoad;
        }
        // If pending, then we can use the existing load as-is
        if (pendingLoads.has(url)) {
            return load;
        }
        // A reload is required after the on-going request is completed
        pendingLoads.add(url);
        const reload = load
            .then(() => startRequest())
            .finally(() => {
                if (runningLoads.get(url) === reload) {
                    runningLoads.delete(url);
                }
            });
        runningLoads.set(url, reload);
        return reload;
    }

    private async requestResource<S, U extends Key<S>>(url: Url, op: RetrieveOperation<S, U, any, any>): Promise<void> {
        const resourceName = op.endpoint.resource.name;
        const resourceUrl = url.toString();
        const currentState = this.getRealResourceState(resourceName, resourceUrl);
        if (currentState && currentState.isLoading) {
            // eslint-disable-next-line no-console
            console.warn(`Started loading resource while previous load was still in progress: ${url}`);
        }
        // Set the collection to the loading state
        let state: ResourceState<S> = {
            error: null,
            resource: null, // Don't reset previous properties
            isLoaded: false,
            ...currentState,
            isLoading: true,
        };
        this.setResourceState(resourceName, resourceUrl, state);
        try {
            // A short debounce to ensure that rapid set of load attempts will result
            // in only one load, without triggering unnecessary reload
            await wait();
            // Reset that the resource load is not pending any more
            this.pendingLoads.delete(resourceUrl);
            // Start actual loading
            const token = await this.getToken(op.authType);
            const response = await this.request(url, 'GET', null, token);
            const resource = op.responseSerializer.deserialize(response.data?.data);
            state = { ...state, error: null, isLoaded: true, resource };
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

    private async requestCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        url: Url,
        op: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
    ) {
        const { direction, ordering, since, ...filters } = input;
        const { resource } = op.endpoint;
        const resourceName = resource.name;
        const collectionUrl = url.toString();
        const currentState = this.getRealCollectionState(resourceName, collectionUrl);
        if (currentState && currentState.isLoading) {
            // eslint-disable-next-line no-console
            console.warn(`Started loading collection while previous load was still in progress: ${url}`);
        }
        // Set the collection to the loading state
        let loadedResources: S[] = [];
        let state: CollectionState<S> = {
            error: null,
            isLoaded: false,
            ...currentState,
            resources: loadedResources,
            count: loadedResources.length,
            isComplete: false,
            isLoading: true,
            ordering,
            direction,
            filters: filters as any,
        };
        this.setCollectionState(resourceName, collectionUrl, state);
        try {
            // A short debounce to ensure that rapid set of load attempts will result
            // in only one load, without triggering unnecessary reload
            await wait();
            // Reset that the resource load is not pending any more
            this.pendingLoads.delete(collectionUrl);
            // Start actual loading
            let nextUrl: Url | null = url;
            while (nextUrl) {
                // Ensure that there are listeners
                const listeners = this.collectionListeners[collectionUrl];
                // eslint-disable-next-line @typescript-eslint/no-loop-func
                if (!listeners || listeners.every(({ minCount }) => minCount <= state.count)) {
                    // No one is interested (any more)
                    break;
                }
                const token = await this.getToken(op.authType);
                const response = await this.request(nextUrl, 'GET', null, token);
                const { next, results } = op.responseSerializer.deserialize(response.data?.data);
                // Add loaded results to the resources
                loadedResources = addResourcesToCollection(loadedResources, results, resource);
                state = {
                    ...state,
                    error: null,
                    resources: loadedResources,
                    count: loadedResources.length,
                    isLoaded: true,
                    isComplete: !next,
                };
                this.setCollectionState(resourceName, collectionUrl, state);
                nextUrl = next && op.route.compile(next);
            }
        } catch (error) {
            // Set the error to the state
            state = { ...state, error };
            this.setCollectionState(resourceName, collectionUrl, state);
        } finally {
            // Set the collection not loading any more
            state = { ...state, isLoading: false };
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
        public readonly authClient: AuthClient,
        resourceCache: ResourceCache = {},
        collectionCache: CollectionCache = {},
    ) {
        super(resourceCache, collectionCache);
    }

    public async request(
        url: Url,
        method: HttpMethod,
        payload: any | null,
        token: string | null,
    ): Promise<ApiResponse> {
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        let response;
        try {
            response = await ajaxJson({
                url: `${this.apiRoot}${url}`,
                method,
                payload,
                headers,
            });
        } catch (error) {
            // If a request returns 401, we assume that the user session has expired,
            // i.e. the user is no longer signed in.
            if (isResponse(error, HttpStatus.Unauthorized)) {
                this.authClient.setAuthentication(null);
            }
            throw error;
        }
        const rawChanges = response.data?.changes;
        const changes: unknown[] = Array.isArray(rawChanges) ? rawChanges : [];
        this.applySerializedChanges(changes);
        return response;
    }

    public upload = async (file: File, upload: UploadForm): Promise<void> => {
        const { action: url, method, ...input } = upload;
        // Decode the normal payload for the request
        const payload = uploadSerializer.omit(['file']).encode(input);
        const formData = new FormData();
        Object.keys(payload).forEach((key) => {
            const value = payload[key];
            if (value != null) {
                formData.set(key, payload[key]);
            }
        });
        if (file.type) {
            // TODO: Validate Content-Type on the client side
            formData.set('Content-Type', file.type);
        }
        // Add each file
        formData.set('file', file);
        await ajax({ url, method, payload: formData });
    };

    /**
     * Clears those resources and collections from the cache that
     * no longer have subscribers.
     */
    public flushCache(): void {
        // TODO
    }
}

export class DummyClient extends BaseClient implements Client {
    constructor(
        public readonly authClient: DummyAuthClient,
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

    public upload(): never {
        throw new NotImplemented(`No client defined`);
    }

    public inquiryResource<S, U extends Key<S>>(
        operation: RetrieveOperation<S, U, any, any>,
        input: Pick<S, U>,
    ): ResourceState<S> {
        const result = super.inquiryResource(operation, input);
        if (this.retrievals) {
            this.retrievals.push({ operation, input });
        }
        return result;
    }

    public inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
        operation: ListOperation<S, U, O, F, any, any>,
        input: Cursor<S, U, O, F>,
    ): CollectionState<S> {
        const result = super.inquiryCollection(operation, input);
        if (this.listings) {
            this.listings.push({ operation, input });
        }
        return result;
    }
}

export interface Bindable<T> {
    bind(client: Client): T;
}

function addResourcesToCollection<T>(collection: T[], items: T[], resource: Resource<T, any, any>): T[] {
    if (!items.length) {
        return collection;
    }
    const { identifyBy } = resource;
    const results: T[] = collection.filter((existing) => {
        const identity = pick(existing, identifyBy);
        return !items.some((item) => hasProperties(item, identity));
    });
    results.push(...items);
    return results;
}

function applyChangeToResource<T>(state: ResourceState<T>, change: ResourceChange<any, any>): ResourceState<T> {
    const { resource: item } = state;
    if (!item || change.type === 'removal' || change.type === 'deletion') {
        return state;
    }
    const { identity } = change;
    if (!hasProperties(item, identity)) {
        return state;
    }
    const delta = getChangeDelta(change);
    return {
        ...state,
        resource: { ...item, ...delta },
    };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function applyChangeToCollection<T, PK extends Key<T>>(
    state: CollectionState<T>,
    change: ResourceAddition<any, any> | ResourceRemoval<any, any>,
): CollectionState<T>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function applyChangeToCollection<T, PK extends Key<T>>(
    state: CollectionState<T>,
    change: ResourceChange<any, any>,
): CollectionState<T> | null;
function applyChangeToCollection<T, PK extends Key<T>>(
    state: CollectionState<T>,
    change: ResourceChange<any, any>,
): CollectionState<T> | null {
    const { identity } = change;
    const isChangedResource = (item: any) => hasProperties(item, identity, 0);
    const isNotChangedResource = (item: any) => !hasProperties(item, identity, 0);
    if (change.type === 'removal' || change.type === 'deletion') {
        // Filter out any matching resource from the collection
        const resources = filter(state.resources, isNotChangedResource);
        return set(state, 'resources', resources);
    }
    if (change.type === 'addition' || change.type === 'replace') {
        const newItem = getNewState(change);
        // Check if the item (now) matches the filters
        if (!hasProperties(newItem, state.filters)) {
            // Resource does not belong to this collection
            if (change.type === 'addition') {
                // Do not alter the collection
                return state;
            }
            // Item might have been removed from the collection
            const resources = filter(state.resources, isNotChangedResource);
            return set(state, 'resources', resources);
        }
        // Ensure that the item won't show up from the original collection
        let resources = filter(state.resources, (item) => !hasProperties(item, identity, 0));
        // Add a new resource to the corresponding position, according to the ordering
        const sortedIndex = findOrderedIndex(resources, newItem, state.ordering, state.direction);
        // If added at the end of the collection, then add only if complete or loading
        if (sortedIndex < resources.length || state.isComplete || state.isLoading) {
            resources = splice(resources, sortedIndex, 0, newItem);
            return set(state, 'resources', resources);
        }
    }
    if (change.type === 'update') {
        // Apply the update to the matching resource
        const delta = getChangeDelta<T, PK>(change);
        const { filters } = state;
        const resources = mapFilter(state.resources, (item) => {
            if (isChangedResource(item)) {
                const updatedState = { ...item, ...delta };
                if (hasProperties(updatedState, filters)) {
                    return updatedState;
                }
                // Resource no more matches the filters!
                // Return undefined -> filter out.
                return undefined;
            }
            // Unmodified resource
            return item;
        });
        if (state.resources !== resources) {
            return { ...state, resources };
        }
        // If the resource was not found from the collection,
        // and the update indicates that the resource would start matching
        // the filters, then we need to reload the collection.
        const filterKeys = Object.keys(filters);
        const update = getChangeDelta(change);
        const hasMatchingFilterProp = filterKeys.some(
            (key) => typeof update[key] !== 'undefined' && isEqual(update[key], filters[key as keyof T]),
        );
        const hasUnmatchingFilterProp = filterKeys.some(
            (key) => typeof update[key] !== 'undefined' && !isEqual(update[key], filters[key as keyof T]),
        );
        if (hasMatchingFilterProp && !hasUnmatchingFilterProp) {
            // The updated resource COULD match these filters, so the resource COULD
            // have become a member of this collection. Must reload.
            return null; // means "unknown" => "reload required"
        }
    }
    return state;
}

type ListMapping<T> = Record<string, T[]>;

function addToMapping<T>(mapping: ListMapping<T>, key: string, value: T): () => void {
    const list = mapping[key] || [];
    list.push(value);
    // eslint-disable-next-line no-param-reassign
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
            list.splice(index, 1);
            if (!list.length) {
                // eslint-disable-next-line no-param-reassign
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
