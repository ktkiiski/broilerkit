import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { ajax } from './ajax';
import { AuthClient } from './auth';
import { ResourceAddition, ResourceRemoval, ResourceUpdate } from './collections';
import { HttpMethod } from './http';
import { Url } from './url';

/**
 * Provides the caching and streaming functionality
 * for the client-side API usage.
 */
export class Client {
    public resourceCache = new Map<string, Observable<any>>();
    public collectionCache = new Map<string, Observable<AsyncIterable<any>>>();
    public resourceAddition$ = new Subject<ResourceAddition<any, any>>();
    public resourceUpdate$ = new Subject<ResourceUpdate<any, any>>();
    public resourceRemoval$ = new Subject<ResourceRemoval<any, any>>();
    public optimisticAdditions$ = new BehaviorSubject<Array<ResourceAddition<any, any>>>([]);
    public optimisticUpdates$ = new BehaviorSubject<Array<ResourceUpdate<any, any>>>([]);
    public optimisticRemovals$ = new BehaviorSubject<Array<ResourceRemoval<any, any>>>([]);

    public stateCache$ = new BehaviorSubject<Record<string, any>>({});

    constructor(
        public readonly apiRoot: string,
        public readonly authClient?: AuthClient,
        public readonly renderRequests?: Set<string>,
    ) {}

    public async request(url: Url, method: HttpMethod, payload: any | null, token: string | null) {
        const headers: Record<string, string> = token ? {Authorization: `Bearer ${token}`} : {};
        return await ajax({
            url: `${this.apiRoot}${url}`,
            method, payload, headers,
        });
    }

    public cacheState(url: string, state: any) {
        const states$ = this.stateCache$.getValue();
        this.stateCache$.next({
            ...states$, [url]: state,
        });
    }

    public registerRender(url: string) {
        const {renderRequests} = this;
        if (renderRequests) {
            renderRequests.add(url);
        }
    }
}

export interface Bindable<T> {
    bind(client: Client): T;
}
