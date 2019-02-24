import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { AuthClient } from './auth';
import { ResourceAddition, ResourceRemoval, ResourceUpdate } from './collections';

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
    constructor(
        public readonly apiRoot: string,
        public readonly authClient?: AuthClient,
    ) {}
}

export interface Bindable<T> {
    bind(client: Client): T;
}
