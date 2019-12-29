import { ajax } from './ajax';
import { AuthClient, DummyAuthClient } from './auth';
import { ResourceChange } from './collections';
import { ApiResponse, HttpMethod, HttpStatus, isErrorResponse, isResponse, NotImplemented } from './http';
import { AuthenticationType, ListOperation, RetrieveOperation } from './operations';
import { Cursor } from './pagination';
import { Resource } from './resources';
import { parseUrl, Url } from './url';
import { getOrderedIndex } from './utils/arrays';
import { hasProperties } from './utils/compare';
import { Key, keys, pick } from './utils/objects';
import { stripPrefix } from './utils/strings';

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
    inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>): CollectionState<S>;
    subscribeCollectionChanges<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>, minCount: number, listener: (collection: CollectionState) => void): () => void;
    registerOptimisticChange(change: ResourceChange<any, any>): () => void;
    commitChange(change: ResourceChange<any, any>): void;
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
    callback: (collection: CollectionState) => void;
    minCount: number;
}

interface ResourceListener {
    resource: Resource<any, any, any>;
    callback: (resource: ResourceState) => void;
}

interface StateEffect {
    resourceName: string;
    encodedResource: {[attr: string]: string};
    available: boolean;
}

const doNothing = () => { /* Does nothing */ };

abstract class BaseClient implements Client {
    protected resourceListeners: ListMapping<ResourceListener> = {};
    protected collectionListeners: ListMapping<CollectionListener> = {};
    private optimisticChanges: Array<ResourceChange<any, any>> = [];
    private uniqueIdCounter = 0;

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
            resource: op.endpoint.resource,
        });
        // Ensure that the resource is being loaded
        this.loadResource(url, op);
        return unsubscribe;
    }

    public inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>): CollectionState<S> {
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
            resource: op.endpoint.resource,
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
        this.triggerResourceUrls(resourceName, changedResourceUrls);
        this.triggerCollectionUrls(resourceName, changedCollectionUrls);
    }

    public generateUniqueId(): number {
        return (this.uniqueIdCounter += 1);
    }

    public abstract request(url: Url, method: HttpMethod, payload: any | null, token: string | null): Promise<ApiResponse>;

    protected applyResourceStates(states: StateEffect[]) {
        if (!states.length) {
            return;
        }
        const changedResourceUrlsByName: ListMapping<string> = {};
        const changedCollectionUrlsByName: ListMapping<string> = {};
        // Apply states to resource states
        for (const { resourceName, encodedResource, available } of states) {
            const resourcesByUrl = this.resourceCache[resourceName];
            if (!resourcesByUrl) {
                // Nothing related to this resource
                continue;
            }
            if (!available) {
                // Single resources do not support "removal"
                continue;
            }
            for (const url of keys(this.resourceListeners)) {
                const listeners = this.resourceListeners[url];
                for (const { resource } of listeners) {
                    // TODO: Support joins!
                    if (resource.name === resourceName && !resource.joins.length) {
                        // Apply state change to the resource
                        const oldState = resourcesByUrl && resourcesByUrl[url];
                        if (oldState && oldState.resource) {
                            let attributes;
                            let identity;
                            try {
                                attributes = resource.decode(encodedResource);
                                identity = resource.identifier.decode(attributes);
                            } catch {
                                // tslint:disable-next-line:no-console
                                console.warn(`Failed to decode resource "${resourceName}" state for a resource side-effect`);
                                continue;
                            }
                            const newState = applyChangeToResource(
                                oldState, { type: 'update', resourceName, resourceIdentity: identity, resource: attributes },
                            );
                            if (newState !== oldState) {
                                resourcesByUrl[url] = newState;
                                addToMapping(changedResourceUrlsByName, resourceName, url);
                            }
                        }
                    }
                    // TODO: Support joins!
                }
            }
        }
        // Apply states to collection states
        for (const { resourceName, encodedResource, available } of states) {
            const collectionsByUrl = this.collectionCache[resourceName];
            if (!collectionsByUrl) {
                // Nothing related to this collection
                continue;
            }
            if (!available) {
                // TODO: Support removal!
                continue;
            }
            for (const url of keys(this.collectionListeners)) {
                const listeners = this.collectionListeners[url];
                for (const { resource } of listeners) {
                    if (resource.name !== resourceName) {
                        // Not this resource
                        continue;
                    }
                    // Apply state change to the collection
                    const oldState = collectionsByUrl && collectionsByUrl[url];
                    if (!oldState) {
                        // Nothing to update
                        continue;
                    }
                    let identity;
                    try {
                        identity = resource.identifier.decode(encodedResource);
                    } catch (error) {
                        // tslint:disable-next-line:no-console
                        console.warn(`Failed to decode resource identity "${resourceName}" state for a collection side-effect`, error);
                        continue;
                    }
                    if (!available) {
                        // Remove the resource instance from collections
                        const newState = applyChangeToCollection(
                            oldState, { type: 'removal', resourceIdentity: identity, resourceName },
                        );
                        if (newState !== oldState) {
                            collectionsByUrl[url] = newState;
                            addToMapping(changedCollectionUrlsByName, resourceName, url);
                        }
                    } else if (!resource.joins.length) {
                        // TODO: Support joins!
                        let attributes;
                        try {
                            attributes = resource.decode(encodedResource);
                        } catch {
                            // TODO: Support nested resources!
                            continue;
                        }
                        // NOTE: The 'addition' here also works for updates
                        const newState = applyChangeToCollection(oldState, {
                            type: 'addition',
                            collectionUrl: url,
                            resourceIdentity: identity,
                            resource: attributes,
                            resourceName,
                        });
                        if (newState !== oldState) {
                            collectionsByUrl[url] = newState;
                            addToMapping(changedCollectionUrlsByName, resourceName, url);
                        }
                    }
                    // TODO: Support joins!
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

    private async getToken(_: AuthenticationType): Promise<string | null> {
        // TODO: Remove this, as the authentication happens with a cookie
        return null;
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
        const {collectionListeners} = this;
        this.triggerCollectionUrls(resourceName, keys(collectionListeners));
    }

    private initResourceState<S, U extends Key<S>>(op: RetrieveOperation<S, U, any, any>, input: Pick<S, U>): [Url | null, ResourceState<S>] {
        const resourceName = op.endpoint.resource.name;
        try {
            const url = op.route.compile(input);
            const state = this.getResourceState(resourceName, url.toString());
            return [url, state || {
                resource: null,
                isLoading: false,
                isLoaded: false,
                error: null,
            }];
        } catch (error) {
            if (!isErrorResponse(error)) {
                throw error;
            }
            return [null, {
                resource: null,
                isLoading: false,
                isLoaded: false,
                error,
            }];
        }
    }
    private initCollectionState<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>): [Url | null, CollectionState<S>] {
        const { ordering, direction, since, ...filters } = input;
        const resourceName = op.endpoint.resource.name;
        try {
            const url = op.route.compile(input);
            const state = this.getCollectionState(resourceName, url.toString());
            return [url, state || {
                resources: [],
                isLoading: false,
                isComplete: false,
                isLoaded: false,
                error: null,
                count: 0,
                ordering,
                direction,
                filters: filters as any,
            }];
        } catch (error) {
            if (!isErrorResponse(error)) {
                throw error;
            }
            return [null, {
                resources: [],
                isLoading: false,
                isComplete: false,
                isLoaded: false,
                error,
                count: 0,
                ordering,
                direction,
                filters: filters as any,
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
        if (currentState && (currentState.isLoading || currentState.isLoaded)) {
            // Already loading or loaded
            return;
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
            const token = await this.getToken(op.authType);
            const response = await this.request(url, 'GET', null, token);
            const resource = op.responseSerializer.deserialize(response.data);
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

    private async loadCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(url: Url, op: ListOperation<S, U, O, F, any, any>, input: Cursor<S, U, O, F>) {
        const { direction, ordering, since, ...filters } = input;
        const resourceName = op.endpoint.resource.name;
        const collectionsByUrl = this.collectionCache[resourceName] || {};
        const collectionUrl = url.toString();
        const currentState = collectionsByUrl[collectionUrl] as CollectionState<S> | undefined;
        if (currentState && (currentState.isLoading || currentState.isLoaded)) {
            // Already loading or loaded
            return;
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
            let nextUrl: Url | null = url;
            while (nextUrl) {
                // Ensure that there are listeners
                const listeners = this.collectionListeners[collectionUrl];
                if (!listeners || listeners.every(({minCount}) => minCount <= state.count)) {
                    // No one is interested (any more)
                    break;
                }
                const token = await this.getToken(op.authType);
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
                    isLoaded: true,
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
        public readonly authClient: AuthClient,
        resourceCache: ResourceCache = {},
        collectionCache: CollectionCache = {},
    ) {
        super(resourceCache, collectionCache);
    }

    public async request(url: Url, method: HttpMethod, payload: any | null, token: string | null) {
        const headers: Record<string, string> = token ? {Authorization: `Bearer ${token}`} : {};
        let response;
        try {
            response = await ajax({
                url: `${this.apiRoot}${url}`,
                method, payload, headers,
            });
        } catch (error) {
            // If a request returns 401, we assume that the user session has expired,
            // i.e. the user is no longer signed in.
            if (isResponse(error, HttpStatus.Unauthorized)) {
                this.authClient.setAuthentication(null);
            }
            throw error;
        }
        const stateHeader = response.headers['Resource-State'];
        const stateHeaders = Array.isArray(stateHeader) ? stateHeader : stateHeader && [stateHeader] || [];
        const states: StateEffect[] = stateHeaders.map((header) => {
            const removal = stripPrefix(header, '!');
            const parsedHeader = parseUrl(removal || header);
            return {
                available: !removal,
                resourceName: parsedHeader.path,
                encodedResource: parsedHeader.queryParams,
            };
        });
        this.applyResourceStates(states);
        return response;
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
    const { resource } = state;
    if (!resource || change.type !== 'update' || !hasProperties(resource, change.resourceIdentity)) {
        return state;
    }
    const fields = keys(resource);
    return {
        ...state,
        resource: { ...resource, ...pick(change.resource, fields) },
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
        // If the item does not match the filters, then do not alter the collection
        if (!hasProperties(change.resource, state.filters)) {
            // Resource does not belong to this collection
            return state;
        }
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
        const resources = iMapFilter(state.resources, (resource) => {
            if (isChangedResource(resource)) {
                const updatedState = { ...resource, ...change.resource };
                if (hasProperties(updatedState, state.filters)) {
                    return updatedState;
                }
                // Resource no more matches the filters!
                // Return nothing -> filter out.
            } else {
                // Unmodified resource
                return resource;
            }
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

function iMapFilter<T>(array: T[], cb: (value: T) => T | void): T[] {
    let counter = 0;
    const result: T[] = [];
    for (const value of array) {
        const newValue = cb(value);
        if (typeof newValue === 'undefined') {
            counter ++;
        } else {
            result.push(newValue);
            if (newValue !== value) {
                counter ++;
            }
        }
    }
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
