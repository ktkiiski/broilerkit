import * as React from 'react';
import { useContext, useMemo } from 'react';
import { Client, DummyClient } from '../client';

/**
 * Context for a API client that is used when binding to
 * API resources and actions.
 */
export const ClientContext = React.createContext<Client>(new DummyClient(null, null, {}, {}));

export function useClient(): Client {
    return useContext(ClientContext);
}

export function useUniqueId(): number {
    const client = useClient();
    return useMemo(() => client.generateUniqueId(), []);
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
