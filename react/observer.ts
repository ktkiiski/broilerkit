import { Component, ComponentClass, ReactNode } from 'react';
import { BehaviorSubject, combineLatest, from, Observable, ObservableInput, Subscription } from 'rxjs';
import { distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { AuthClient, AuthUser } from '../auth';
import { Observablish } from '../rxjs';
import { isEqual } from '../utils/compare';
import { Key, omit } from '../utils/objects';

type ObservedProps<P> = Pick<P, Exclude<Key<P>, 'children'>>;

/**
 * React component whose state is bound to the emitted values of an RxJS Observable.
 */
export abstract class ObserverComponent<P, T extends object> extends Component<P, Partial<T>> {

    public state: T = {} as T;
    /**
     * Observable for the `props` of this component.
     * This can be used for the `state$` Observable.
     */
    protected props$ = new BehaviorSubject(getProps(this.props));
    /**
     * The observable for the component's state.
     * This will be subscribed when mounting the component
     * and unsubscribed once unmounted. Emitted values
     * will be called as a parameter for `setState(...)`
     *
     * You should use the `props$` property if the state
     * depends on the component `props`.
     */
    protected abstract state$: Observablish<T>;
    /**
     * The subscription for the state$ observable.
     */
    private subscription = new Subscription();

    public componentDidMount() {
        this.subscription.add(
            this.state$.subscribe({
                next: (state) => this.setState(state),
            }),
        );
    }
    public componentDidUpdate(prevProps: P) {
        const props = getProps(this.props);
        if (!isEqual(props, getProps(prevProps))) {
            this.props$.next(props);
        }
    }
    public componentWillUnmount() {
        this.subscription.unsubscribe();
    }
    public pluckProp<K extends Exclude<Key<P>, 'children'>>(prop: K): Observable<P[K]> {
        return this.props$.pipe(
            map((props) => props[prop]),
            distinctUntilChanged(isEqual),
        );
    }
}
function getProps<P>(props: Readonly<{ children?: React.ReactNode }> & Readonly<P>): ObservedProps<P> {
    return omit(props, ['children']);
}

export interface SimpleRenderObservableOptions<P, T> {
    observable: ObservableInput<T> | ((props: ObservedProps<P>) => ObservableInput<T>);
    render?: (value: T | undefined, props: Readonly<{ children?: ReactNode }> & Readonly<P>) => ReactNode;
}
export interface UserRenderObservableOptions<P, T> {
    auth: AuthClient;
    observable: (props: ObservedProps<P>, user: AuthUser | null) => ObservableInput<T>;
    render: (value: T | undefined, user: AuthUser | null, props: Readonly<{ children?: ReactNode }> & Readonly<P>) => ReactNode;
}

export function renderObservable<P, T>({render, observable}: SimpleRenderObservableOptions<P, T>): ComponentClass<P> {
    class SimpleObserverComponent extends ObserverComponent<P, {value: T}> {
        protected state$ = typeof observable === 'function'
            ? this.props$.pipe(
                distinctUntilChanged(isEqual),
                switchMap(observable),
                map((value) => ({value})),
            )
            : from(observable).pipe(map((value) => ({value})))
        ;
        public render() {
            if (render) {
                return render(this.state.value, this.props);
            }
        }
    }
    return SimpleObserverComponent;
}

export function renderObservableWithUser<P, T>({auth, observable, render}: UserRenderObservableOptions<P, T>): ComponentClass<P> {
    const user$ = auth.user$;
    class AuthObserverComponent extends ObserverComponent<P, {value: T, user: AuthUser | null}> {
        protected state$ = combineLatest(this.props$, user$).pipe(
            distinctUntilChanged<[ObservedProps<P>, AuthUser | null]>(isEqual),
            switchMap(([props, user]) => from(observable(props, user)).pipe(
                map((value) => ({value, user})),
            )),
        );
        public render() {
            return render(this.state.value, this.state.user || null, this.props);
        }
    }
    return AuthObserverComponent;
}

export function renderUser<P = {}>(authClient: AuthClient) {
    class UserComponent extends ObserverComponent<P, {user: AuthUser | null}> {
        protected state$ = authClient.user$.pipe(map((user) => ({user})));
    }
    return UserComponent;
}
