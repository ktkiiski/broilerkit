import { Observable } from 'rxjs';
import { distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { IntermediateCollection, ObservableEndpoint, ObservableUserEndpoint } from '../api';
import { observeValues } from '../observables';
import { isEqual } from '../utils/compare';
import { Optional, spread, transformValues } from '../utils/objects';
import { ObserverComponent } from './observer';

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
    class UserResourceComponent<X = {}> extends ObserverComponent<I & X, Nullable<O> & S> {
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
            switchMap((observables) => observeValues(observables)),
        );
    }
    return UserResourceComponent;
}

export function renderResources<I, O extends object, S extends object>(endpoints: ResourceEndpoints<I, O>, defaultState?: S) {
    class ResourceComponent<X = {}> extends ObserverComponent<I & X, Nullable<O> & S> {
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
            switchMap((observables) => observeValues(observables)),
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
