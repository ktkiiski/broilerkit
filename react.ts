import { Component, ReactNode } from 'react';
import { BehaviorSubject, Observable, Subscribable, Subscription } from 'rxjs';

/**
 * Creates a React component whose state is bound to the subscribed RxJS Observable.
 */
export function observe<T, P>(observable: ((props: Observable<P>) => Subscribable<T>) | Subscribable<T>, render: (state: T | undefined, props: P) => ReactNode) {
    class ObservingComponent extends Component<P, {value?: T}> {
        public state: {value?: T} = {};
        private propSubject: BehaviorSubject<P>;
        private subscription = new Subscription();
        constructor(props: P) {
            super(props);
            this.propSubject = new BehaviorSubject(props);
        }
        public componentDidMount() {
            const obs = typeof observable === 'function' ? observable(this.propSubject) : observable;
            this.subscription.add(obs.subscribe(this.onNext));
        }
        public componentDidUpdate(_: any, newProps: any) {
            this.propSubject.next(newProps);
        }
        public componentWillUnmount() {
            this.subscription.unsubscribe();
        }
        public render() {
            const {state, props} = this;
            return render(state && state.value, props);
        }
        private onNext = (value: T) => {
            this.setState({value});
        }
    }
    return ObservingComponent;
}
