import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { ajax } from './ajax';
import { AuthClient } from './auth';
import { ResourceAddition, ResourceRemoval, ResourceUpdate } from './collections';
import { ApiResponse, HttpMethod, NotImplemented } from './http';
import { Operation } from './operations';
import { Url } from './url';

export interface OperationAction<I = any> {
    operation: Operation<I, any, any>;
    input: I;
}

export interface Client {
    resourceCache: Map<string, Observable<any>>;
    collectionCache: Map<string, Observable<AsyncIterable<any>>>;
    resourceAddition$: Subject<ResourceAddition<any, any>>;
    resourceUpdate$: Subject<ResourceUpdate<any, any>>;
    resourceRemoval$: Subject<ResourceRemoval<any, any>>;
    optimisticAdditions$: BehaviorSubject<Array<ResourceAddition<any, any>>>;
    optimisticUpdates$: BehaviorSubject<Array<ResourceUpdate<any, any>>>;
    optimisticRemovals$: BehaviorSubject<Array<ResourceRemoval<any, any>>>;
    stateCache$: BehaviorSubject<Record<string, any>>;

    readonly authClient?: AuthClient | null;
    request(url: Url, method: HttpMethod, payload: any | null, token: string | null): Promise<ApiResponse>;
    registerRender<I>(operation: Operation<I, any, any>, input: I): void;
}

abstract class BaseClient implements Client {
    public resourceCache = new Map<string, Observable<any>>();
    public collectionCache = new Map<string, Observable<AsyncIterable<any>>>();
    public resourceAddition$ = new Subject<ResourceAddition<any, any>>();
    public resourceUpdate$ = new Subject<ResourceUpdate<any, any>>();
    public resourceRemoval$ = new Subject<ResourceRemoval<any, any>>();
    public optimisticAdditions$ = new BehaviorSubject<Array<ResourceAddition<any, any>>>([]);
    public optimisticUpdates$ = new BehaviorSubject<Array<ResourceUpdate<any, any>>>([]);
    public optimisticRemovals$ = new BehaviorSubject<Array<ResourceRemoval<any, any>>>([]);
    public stateCache$ = new BehaviorSubject<Record<string, any>>({});

    public abstract authClient?: AuthClient | null;

    constructor(stateCache?: Record<string, any>) {
        if (stateCache) {
            this.stateCache$.next(stateCache);
        }
    }

    public abstract request(url: Url, method: HttpMethod, payload: any | null, token: string | null): Promise<ApiResponse>;
    public abstract registerRender<I>(operation: Operation<I, any, any>, input: I): void;
}

/**
 * Provides the caching and streaming functionality
 * for the client-side API usage.
 */
export class BrowserClient extends BaseClient implements Client {
    constructor(
        public readonly apiRoot: string,
        public readonly authClient?: AuthClient | null,
        stateCache?: Record<string, any>,
    ) {
        super(stateCache);
    }

    public async request(url: Url, method: HttpMethod, payload: any | null, token: string | null) {
        const headers: Record<string, string> = token ? {Authorization: `Bearer ${token}`} : {};
        return await ajax({
            url: `${this.apiRoot}${url}`,
            method, payload, headers,
        });
    }

    public registerRender() {
        // No-op for an actual client in a browser
    }
}

export class DummyClient extends BaseClient implements Client {
    public authClient: undefined;
    constructor(
        public readonly renderRequests?: OperationAction[],
        stateCache?: Record<string, any>,
    ) {
        super(stateCache);
    }
    public request(): never {
        throw new NotImplemented(`No client defined`);
    }

    public registerRender<I>(operation: Operation<I, any, any>, input: I) {
        const {renderRequests} = this;
        if (renderRequests) {
            renderRequests.push({operation, input});
        }
    }
}

export interface Bindable<T> {
    bind(client: Client): T;
}
