import * as React from 'react';
import { combineLatest } from 'rxjs';
import { distinctUntilChanged, filter, map, switchMap } from 'rxjs/operators';
import { Bindable, Connectable } from '../bindable';
import { Client } from '../client';
import { isEqual, isNotNully } from '../utils/compare';
import { mapObject, omit } from '../utils/objects';
import { ObserverComponent } from './observer';

export type PropInjector<B, X> = <A extends B>(cmp: React.ComponentType<A>) => React.ComponentType<Pick<A, Exclude<keyof A, keyof B>> & X>;

/**
 * Converts a union type, e.g. `A | B | C` to an intersection
 * type, e.g. `A & B & C`
 */
export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

/**
 * Context for a API client that is used when binding to
 * API resources and actions.
 */
export const ClientContext = React.createContext<Client | null>(null);

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

export function connect<I, O>(
    bindings: {[P in keyof I]: Bindable<Connectable<I[P], any>>} & {[P in keyof O]: Bindable<Connectable<any, O[P]>>},
): PropInjector<UnionToIntersection<I[keyof I]> & O, UnionToIntersection<I[keyof I]>> {
    return (WrappedComponent: React.ComponentType<any>) => {
        class ClientBoundComponent extends ObserverComponent<{client: Client | null}, {props?: {[key: string]: any}}> {
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
                map((props) => ({props})),
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
 * Infers the properties for a component by a return value of `connect`.
 */
export type ConnectedProps<I> = I extends PropInjector<infer R, any> ? R : never;
