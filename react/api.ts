import { Observable } from 'rxjs';
import { distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { IntermediateCollection, ObservableUserEndpoint } from '../api';
import { observeValues } from '../observables';
import { isEqual } from '../utils/compare';
import { omit, Optional, spread, transformValues } from '../utils/objects';
import { ObserverComponent } from './observer';

export type UserResourceInputs<I> = {
    [P in keyof I]: ObservableUserEndpoint<I[P], any>;
};
export type UserResourceOutputs<O> = {
    [P in keyof O]: ObservableUserEndpoint<any, O[P]>;
};
export type UserResourceEndpoints<I, O> = UserResourceInputs<I> & UserResourceOutputs<O>;
export type Nullable<T> = {[P in keyof T]: T[P] | null};

export function renderUserResources<I, O extends object, S extends object>(endpoints: UserResourceEndpoints<I, O>, defaultState?: S) {
    class UserResourceComponent extends ObserverComponent<I, Nullable<O> & S> {
        public state = spread(
            transformValues(endpoints, () => null) as Nullable<O>,
            defaultState,
        );
        public state$ = this.props$.pipe(
            distinctUntilChanged(isEqual),
            map((props) => transformValues(
                endpoints as any,
                (endpoint: ObservableUserEndpoint<I[keyof I], O[keyof O]>, key) => endpoint.observeWithUser(props[key as keyof I]),
            ) as {[P in keyof O]: Observable<Nullable<O>[P]>}),
            switchMap((observables) => observeValues(observables)),
        );
    }
    return UserResourceComponent;
}

export interface UserCollectionState<O> {
    items: O[] | null;
    isComplete: boolean;
}
export type UserCollectionProps<I extends D, D> = Optional<I, keyof D>;
export function renderUserCollection<I extends D, O, D extends object = {}>(endpoint: ObservableUserEndpoint<I, IntermediateCollection<O>>, defaultInput?: D) {
    class UserCollectionComponent extends ObserverComponent<UserCollectionProps<I, D>, UserCollectionState<O>> {
        public state$ = this.props$.pipe(
            map((props) => spread(omit(props, ['children']), defaultInput) as I),
            distinctUntilChanged(isEqual),
            switchMap((props) => endpoint.observeWithUser(props)),
            map((collection) => (collection || {items: null, isComplete: false}) as UserCollectionState<O>),
        );
    }
    return UserCollectionComponent;
}
