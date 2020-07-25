/* eslint-disable @typescript-eslint/no-explicit-any */
import hasProperties from 'immuton/hasProperties';
import isEqual from 'immuton/isEqual';
import isNotNully from 'immuton/isNotNully';
import type { Key } from 'immuton/types';
import { useEffect, useState } from 'react';
import type { Bindable, Client } from '../client';
import { HttpStatus, isResponse } from '../http';
import type { ListOperation, RetrieveOperation } from '../operations';
import type { Cursor } from '../pagination';
import { useClient } from './client';

// TODO: Excplicit error type!
type Resource<T> = [T | null, any, boolean];

// TODO: More explicit typing for the error
type List<S> = [S[] | null, any | null, boolean];

interface Collection<T> {
    resources: T[];
    count: number;
    isLoading: boolean;
    isComplete: boolean;
    // TODO: Excplicit error type!
    error: any | null;
}

export function useResource<S, U extends Key<S>>(
    op: RetrieveOperation<S, U, any, any>,
    input: Pick<S, U>,
): Resource<S> {
    const client = useClient();
    const [state, setState] = useState(client.inquiryResource(op, input));
    const { error } = state;
    const isValid = !error || !isResponse(error, HttpStatus.BadRequest);
    useEffect(() => {
        if (input && isValid) {
            return client.subscribeResourceChanges(op, input, (newState) => {
                setState((oldState) => (isEqual(oldState, newState, 2) ? oldState : newState));
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, op, getFingerprint(input), isValid]);
    return [state.resource, state.error, state.isLoading];
}

export function useCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    minCount: number,
    input: Cursor<S, U, O, F>,
    filters?: Partial<S> | null,
): Collection<S> {
    return useCollectionIf(op, minCount, input, filters);
}

// TODO: Unnecessary? Just offet useCollection and simplify implementation!
function useCollectionIf<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    minCount: number,
    input: Cursor<S, U, O, F> | null | undefined,
    filters?: Partial<S> | null,
): Collection<S> {
    const client = useClient();
    const [state, setState] = useState(inquiryCollection(client, op, input, filters));
    useEffect(() => {
        if (input) {
            return client.subscribeCollectionChanges(op, input, minCount, (newState) => {
                const filteredState = applyCollectionFilters(newState, filters);
                setState((oldState) => (isEqual(oldState, filteredState, 2) ? oldState : filteredState));
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, op, getFingerprint(input), getFingerprint(filters), minCount]);
    return state;
}

export function useList<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
    filters?: Partial<S> | null,
): List<S> {
    return useListIf(op, input, filters);
}

// TODO: Unnecessary? Just offet useList and simplify implementation!
function useListIf<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F> | null | undefined,
    filters?: Partial<S> | null,
): List<S> {
    const client = useClient();
    const initialCollection = inquiryCollection(client, op, input, filters);
    const [resources, setResources] = useState(initialCollection.resources);
    const [error, setError] = useState(initialCollection.error);
    const [isLoading, setIsLoading] = useState(initialCollection.isLoading);
    useEffect(() => {
        let latestResources = resources;
        let latestError = error;
        let latestIsLoading = error;
        if (input) {
            return client.subscribeCollectionChanges(op, input, Number.POSITIVE_INFINITY, (newState) => {
                const state = applyCollectionFilters(newState, filters);
                if (state.isComplete && !isEqual(latestResources, state.resources, 1)) {
                    latestResources = state.resources;
                    setResources(latestResources);
                }
                if (state.error !== latestError) {
                    latestError = state.error;
                    setError(latestError);
                }
                if (state.isLoading !== latestIsLoading) {
                    latestIsLoading = state.isLoading;
                    setIsLoading(latestIsLoading);
                }
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, op, getFingerprint(input), getFingerprint(filters)]);
    return [resources, error, isLoading];
}

export function useCollections<
    S,
    U extends Key<S>,
    O extends Key<S>,
    F extends Key<S>,
    I extends Cursor<S, U, O, F>[] = Cursor<S, U, O, F>[]
>(op: ListOperation<S, U, O, F, any, any>, inputs: I, filters?: Partial<S> | null): { [P in keyof I]: Collection<S> } {
    const client = useClient();
    const [states, setState] = useState(inputs.map((input) => inquiryCollection(client, op, input, filters)));
    useEffect(() => {
        const resultStates: (Collection<S> | null)[] = inputs.map(() => null);
        if (!inputs.length) {
            setState([]);
        }
        const subscriptions = inputs.map((input, i) =>
            client.subscribeCollectionChanges(op, input, Number.POSITIVE_INFINITY, (newCollection) => {
                const filteredCollection = applyCollectionFilters(newCollection, filters);
                if (!isEqual(resultStates[i], filteredCollection, 2)) {
                    resultStates[i] = filteredCollection;
                    if (resultStates.every(isNotNully)) {
                        setState((resultStates as Collection<S>[]).slice());
                    }
                }
            }),
        );
        return () => {
            subscriptions.forEach((unsubscribe) => unsubscribe());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, op, getFingerprint(inputs), getFingerprint(filters)]);
    return states as { [P in keyof I]: Collection<S> };
}

export function useOperation<T>(op: Bindable<T>): T {
    const client = useClient();
    return op.bind(client);
}

function getFingerprint(obj: unknown) {
    if (typeof obj === 'object' && obj) {
        return JSON.stringify(obj);
    }
    return obj;
}

function inquiryCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    client: Client,
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F> | null | undefined,
    filters: Partial<S> | null | undefined,
): Collection<S> {
    if (!input) {
        return {
            resources: [],
            isLoading: true,
            isComplete: false,
            error: null,
            count: 0,
        };
    }
    return applyCollectionFilters(client.inquiryCollection(op, input), filters);
}

function applyCollectionFilters<S, C extends Collection<S>>(collection: C, filters: Partial<S> | null | undefined): C {
    return !filters
        ? collection
        : {
              ...collection,
              resources: collection.resources.filter((resource) => hasProperties(resource, filters)),
          };
}
