import * as React from 'react';
import { useContext } from 'react';
import { combineLatest } from 'rxjs';
import { distinctUntilChanged, filter, map, switchMap } from 'rxjs/operators';
import { Bindable, Connectable } from '../bindable';
import { Client } from '../client';
import { isEqual, isNotNully } from '../utils/compare';
import { mapObject, omit } from '../utils/objects';
import { ObserverComponent } from './observer';

/**
 * Context for a API client that is used when binding to
 * API resources and actions.
 */
export const ClientContext = React.createContext<Client | null>(null);

export function useClient(): Client | null {
    return useContext(ClientContext);
}

export function useWithClient<R, P extends any[] = []>(exec: (client: Client, ...args: P) => R, defaultValue?: R): (...args: P) => R {
    const client = useClient();
    return (...args: P) => {
        if (client) {
            return exec(client, ...args);
        } else if (typeof defaultValue === 'undefined') {
            throw new Error(`Client not available! Either called too early on the first render or ClientContext is missing.`);
        }
        return defaultValue;
    };
}

interface ClientProviderProps {
    client: Client;
    children?: React.ReactNode;
}

/**
 * Provides the proper client context for all the nested components
 * that have been bound to the API resources.
 */
export const ClientProvider = ({client, ...props}: ClientProviderProps) => (
    <ClientContext.Provider value={client} {...props} />
);

export function connect<I, O1, O2 = O1>(
    bindings: {[P in keyof I]: Bindable<Connectable<I[P], any>>} & {[P in keyof O1]: Bindable<Connectable<any, O1[P]>>},
    mapProps?: (props: O1) => O2,
): PropInjector<UnionToIntersection<I[keyof I]> & O2, UnionToIntersection<I[keyof I]>> {
    return (WrappedComponent: React.ComponentType<any>) => {
        class ClientBoundComponent extends ObserverComponent<{client: Client | null}, {props?: O2}> {
            public state$ = this.pluckProp('client').pipe(
                filter(isNotNully),
                switchMap((client) => combineLatest(
                    this.props$,
                    ...mapObject(
                        bindings,
                        (bindable: Bindable<Connectable<any, any>>, key: string) => (
                            bindable.bind(client).connect(this.props$).pipe(
                                map((value) => ({[key]: value})),
                            )
                        ),
                    ),
                    (...results) => omit(Object.assign({}, ...results), ['client']),
                )),
                distinctUntilChanged(isEqual),
                map(mapProps
                    ? (props) => ({props: mapProps(props)})
                    : (props) => ({props: props as O2}),
                ),
            );
            public render() {
                const {props} = this.state;
                return props == null ? null : <WrappedComponent {...props} />;
            }
        }
        return (props: any) => (
            <ClientContext.Consumer>
                {(client) => <ClientBoundComponent {...props} client={client} />}
            </ClientContext.Consumer>
        );
    };
}

/**
 * Converts a union type, e.g. `A | B | C` to an intersection
 * type, e.g. `A & B & C`
 */
export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

/**
 * Infers the properties for a component by a return value of `connect`.
 */
export type ConnectedProps<I> = I extends PropInjector<infer R, any> ? R : never;

export type PropInjector<B, X> = <A extends B>(cmp: React.ComponentType<A>) => React.ComponentType<Pick<A, Exclude<keyof A, keyof B>> & X>;
