import { Component, ReactNode } from 'react';
import { Subscribable, Subscription } from 'rxjs';

/**
 * Creates a React component whose state is bound to the subscribed RxJS Observable.
 */
export function observe<T, P>(observable: Subscribable<T>, render: (state: T | undefined, props: P) => ReactNode) {
    class ObservingComponent extends Component<P, {value?: T}> {
        public state: {value?: T} = {};
        private subscription = new Subscription();
        public componentDidMount() {
            this.subscription.add(observable.subscribe((value) => {
                this.setState({value});
            }));
        }
        public componentWillUnmount() {
            this.subscription.unsubscribe();
        }
        public render() {
            const {state, props} = this;
            return render(state && state.value, props);
        }
    }
    return ObservingComponent;
}
