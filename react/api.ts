import { combineLatest, never, Observable, of } from 'rxjs';
import { distinctUntilChanged, filter, map, switchMap, take } from 'rxjs/operators';
import { IntermediateCollection, ListOperation, ObservableEndpoint, ObservableUserEndpoint, RetrieveOperation } from '../api';
import { Bindable } from '../bindable';
import { observeValues } from '../observables';
import { Cursor } from '../pagination';
import { isEqual } from '../utils/compare';
import { Key, Omit, Optional, spread, transformValues } from '../utils/objects';
import { useClient, useWithClient } from './client';
import { ObserverComponent } from './observer';
import { useObservable } from './rxjs';

export type UserResourceInputs<I> = {
    [P in keyof I]: ObservableUserEndpoint<I[P], any>;
};
export type UserResourceOutputs<O> = {
    [P in keyof O]: ObservableUserEndpoint<any, O[P]>;
};
export type UserResourceEndpoints<I, O> = UserResourceInputs<I> & UserResourceOutputs<O>;

export type ResourceInputs<I> = {
    [P in keyof I]: ObservableEndpoint<I[P], any>;
};
export type ResourceOutputs<O> = {
    [P in keyof O]: ObservableEndpoint<any, O[P]>;
};
export type ResourceEndpoints<I, O> = ResourceInputs<I> & ResourceOutputs<O>;
export type Nullable<T> = {[P in keyof T]: T[P] | null};

export function renderUserResources<I, O extends object, S extends object>(endpoints: UserResourceEndpoints<I, O>, defaultState?: S) {
    class UserResourceComponent<X = {}> extends ObserverComponent<I & X, Nullable<O>, S> {
        public state = spread(
            transformValues(endpoints, () => null) as Nullable<O>,
            defaultState,
        );
        public state$ = this.props$.pipe(
            distinctUntilChanged(isEqual),
            map((props: any) => transformValues(
                endpoints as any,
                (endpoint: ObservableUserEndpoint<I[keyof I], O[keyof O]>, key) => endpoint.observeWithUser(props[key]),
            ) as {[P in keyof O]: Observable<Nullable<O>[P]>}),
            switchMap((observables) => observeValues<Nullable<O>>(observables)),
        );
    }
    return UserResourceComponent;
}

export function renderResources<I, O extends object, S extends object>(endpoints: ResourceEndpoints<I, O>, defaultState?: S) {
    class ResourceComponent<X = {}> extends ObserverComponent<I & X, Nullable<O>, S> {
        public state = spread(
            transformValues(endpoints, () => null) as Nullable<O>,
            defaultState,
        );
        public state$ = this.props$.pipe(
            distinctUntilChanged(isEqual),
            map((props: any) => transformValues(
                endpoints as any,
                (endpoint: ObservableEndpoint<I[keyof I], O[keyof O]>, key) => endpoint.observe(props[key]),
            ) as {[P in keyof O]: Observable<Nullable<O>[P]>}),
            switchMap((observables) => observeValues<Nullable<O>>(observables)),
        );
    }
    return ResourceComponent;
}

export interface CollectionState<O> {
    items: O[] | null;
    isComplete: boolean;
}
export type CollectionProps<I extends D, D> = Optional<I, keyof D>;
export function renderUserCollection<I extends D, O, D = {}>(endpoint: ObservableUserEndpoint<I, IntermediateCollection<O>>, defaultInput?: D) {
    class UserCollectionComponent<X = {}> extends ObserverComponent<CollectionProps<I, D> & X, CollectionState<O>> {
        public state$ = endpoint.observeWithUserSwitch(this.props$.pipe(
                map((props: any) => spread(defaultInput, props) as I),
            )).pipe(
                map((collection) => (collection || {items: null, isComplete: false}) as CollectionState<O>),
            )
        ;
    }
    return UserCollectionComponent;
}

export function renderCollection<I extends D, O, D = {}>(endpoint: ObservableEndpoint<I, IntermediateCollection<O>>, defaultInput?: D) {
    class CollectionComponent<X = {}> extends ObserverComponent<CollectionProps<I, D> & X, CollectionState<O>> {
        public state$ = endpoint.observeSwitch(this.props$.pipe(
            map((props: any) => spread(defaultInput, props) as I),
        ));
    }
    return CollectionComponent;
}

export function useResource<S, U extends Key<S>>(
    op: RetrieveOperation<S, U, any, any>,
    input: Pick<S, U>,
): S | null {
    return useBoundObservable(op, input, (i, model) => model.observe(i));
}

export function useResourceWithAuth<S, U extends Key<S>, B extends U>(
    op: RetrieveOperation<S, U, any, B>,
    input: Pick<S, Exclude<U, B>>,
): S | null {
    return useBoundObservable(op, input, (i, model) => model.observeWithUser(i));
}

export function useList<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): S[] | null {
    return useBoundObservable(op, input, (i, model) => model.observeAll(i));
}

export function useListOnce<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): S[] | null {
    return useBoundObservable(op, input, (i, model) => model.observeAll(i).pipe(take(1)));
}

export function useListWithAuth<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B extends U>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Omit<Cursor<S, U, O, F>, B>,
): S[] | null {
    return useBoundObservable(
        op, input, (i, model) => model.observeAllWithUser(i),
    );
}

export function useListMany<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    inputs: Array<Cursor<S, U, O, F>>,
): S[][] | null {
    return useBoundObservable(
        op, inputs, (i, model) => !i.length ? of([]) : combineLatest(
            i.map((input) => model.observe(input).pipe(
                filter((collection) => collection.isComplete),
                map((collection) => collection.items),
            )),
        ),
    );
}

export function useOperation<T, P extends any[] = [], R = void>(op: Bindable<T>, exec: (model: T, ...args: P) => R): (...args: P) => R {
    return useWithClient((client, ...args: P) => {
        const model = op.bind(client);
        return exec(model, ...args);
    });
}

const nothing$ = never();

function useBoundObservable<I, T, R>(
    op: Bindable<T>,
    input: I,
    observe: (input: I, model: T) => Observable<R>,
    extraDeps: any[] = [],
): R | null {
    const client = useClient();
    const fingerprint = getFingerprint(input);
    return useObservable(
        null,
        () => {
            // No client (yet), no subscription
            if (!client) {
                return nothing$;
            }
            const model = op.bind(client);
            return observe(input, model);
        },
        [client, fingerprint, ...extraDeps],
    );
}

function getFingerprint(obj: unknown) {
    if (typeof obj === 'object' && obj) {
        return JSON.stringify(obj);
    }
    return obj;
}
