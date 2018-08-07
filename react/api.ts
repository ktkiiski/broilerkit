import { Observable } from 'rxjs';
import { distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { ObservableUserEndpoint } from '../api';
import { observeValues } from '../observables';
import { isEqual } from '../utils/compare';
import { transformValues } from '../utils/objects';
import { ObserverComponent } from './observer';

export type UserResourceInputs<I> = {
    [P in keyof I]: ObservableUserEndpoint<I[P], any>;
};
export type UserResourceOutputs<O> = {
    [P in keyof O]: ObservableUserEndpoint<any, O[P]>;
};
export type UserResourceEndpoints<I, O> = UserResourceInputs<I> & UserResourceOutputs<O>;
export type Nullable<T> = {[P in keyof T]: T[P] | null};

export function renderUserResources<I, O extends object>(endpoints: UserResourceEndpoints<I, O>) {
    class UserResourceComponent extends ObserverComponent<I, Nullable<O>> {
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
