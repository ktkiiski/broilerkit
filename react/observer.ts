import { Component, ComponentClass, ReactNode } from 'react';
import { BehaviorSubject, combineLatest, from, ObservableInput, Subscribable, Subscription } from 'rxjs';
import { distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { AuthClient, AuthUser } from '../auth';
import { isEqual } from '../utils/compare';
import { pick } from '../utils/objects';

/**
 * React component whose state is bound to the emitted values of an RxJS Observable.
 */
export abstract class ObserverComponent<P, T extends {}> extends Component<P, T> {
    public state: T = {} as T;
    /**
     * Observable for the props of this component.
     */
    protected props$ = new BehaviorSubject(this.props);
    /**
     * The subscription for the observable.
     */
    protected subscription = new Subscription();
    /**
     * The observable for the component's state.
     * This will be subscribed when mounting the component
     * and unsubscribed once unmounted.
     *
     * You should use the props$ if the state depends
     * on the component props.
     */
    protected abstract state$: Subscribable<T>;
    constructor(props: P) {
        super(props);
    }
    public componentDidMount() {
        this.subscription.add(
            this.state$.subscribe((state) => this.setState(state)),
        );
    }
    public componentDidUpdate() {
        this.props$.next(this.props);
    }
    public componentWillUnmount() {
        this.subscription.unsubscribe();
    }
}

export interface SimpleRenderObservableOptions<P, T> {
    observable: ObservableInput<T> | ((props: P) => ObservableInput<T>);
    render: (value: T | undefined, props: P) => ReactNode;
}
export interface UserRenderObservableOptions<P, T> {
    auth: AuthClient;
    observable: (props: P, user: AuthUser | null) => ObservableInput<T>;
    render: (value: T | undefined, user: AuthUser | null, props: P) => ReactNode;
}
export interface RenderUserOptions<P> {
    auth: AuthClient;
    render: (user: AuthUser | null, props: P) => ReactNode;
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
            return render(this.state.value, this.props);
        }
    }
    return SimpleObserverComponent;
}

export function renderObservableWithUser<P, T>({auth, observable, render}: UserRenderObservableOptions<P, T>): ComponentClass<P> {
    const user$ = auth.observe().pipe(
        map((user) => user && pick(user, ['id', 'name', 'email']) as AuthUser),
        distinctUntilChanged<AuthUser | null>(isEqual),
    );
    class AuthObserverComponent extends ObserverComponent<P, {value: T, user: AuthUser | null}> {
        protected state$ = combineLatest(this.props$, user$).pipe(
            distinctUntilChanged<[P, AuthUser | null]>(isEqual),
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

export function renderUser<P>({auth, render}: RenderUserOptions<P>): ComponentClass<P> {
    const user$ = auth.observe().pipe(
        map((user) => user && pick(user, ['id', 'name', 'email']) as AuthUser),
        distinctUntilChanged<AuthUser | null>(isEqual),
    );
    class AuthComponent extends ObserverComponent<P, {user: AuthUser | null}> {
        protected state$ = user$.pipe(map((user) => ({user})));
        public render() {
            return render(this.state.user, this.props);
        }
    }
    return AuthComponent;
}
