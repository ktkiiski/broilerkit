import { useEffect, useState } from 'react';
import { Bindable, Client } from '../client';
import { HttpStatus, isErrorResponse } from '../http';
import { ListOperation, RetrieveOperation } from '../operations';
import { Cursor } from '../pagination';
import { hasProperties, isEqual, isNotNully } from '../utils/compare';
import { Key } from '../utils/objects';
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
    const [state, setState] = useState(
        client.inquiryResource(op, input),
    );
    const {error} = state;
    const isValid = !isValidationError(error);
    useEffect(() => {
        if (input && isValid) {
            return client.subscribeResourceChanges(op, input, (newState) => {
                if (!isEqual(state, newState, 2)) {
                    setState(newState);
                }
            });
        }
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
    const [state, setState] = useState(
        inquiryCollection(client, op, input, filters),
    );
    useEffect(() => {
        if (input) {
            return client.subscribeCollectionChanges(
                op, input, minCount,
                (newState) => {
                    const filteredState = applyCollectionFilters(newState, filters);
                    if (!isEqual(state, filteredState, 2)) {
                        setState(filteredState);
                    }
                },
            );
        }
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
    const [state, setState] = useState(
        listifyCollection(inquiryCollection(client, op, input, filters)),
    );
    useEffect(() => {
        if (input) {
            return client.subscribeCollectionChanges(
                op, input, Number.POSITIVE_INFINITY,
                (newState) => {
                    const newListState = listifyCollection(
                        newState.isComplete ? applyCollectionFilters(newState, filters) : newState,
                    );
                    if (!isEqual(state, newListState, 2)) {
                        setState(newListState);
                    }
                },
            );
        }
    }, [client, op, getFingerprint(input), getFingerprint(filters)]);
    return state;
}

export function useCollections<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, I extends Array<Cursor<S, U, O, F>> = Array<Cursor<S, U, O, F>>>(
    op: ListOperation<S, U, O, F, any, any>,
    inputs: I,
    filters?: Partial<S> | null,
): {[P in keyof I]: Collection<S>} {
    const client = useClient();
    const [states, setState] = useState(
        inputs.map((input) => inquiryCollection(client, op, input, filters)),
    );
    useEffect(() => {
        const resultStates: Array<Collection<S> | null> = inputs.map(() => null);
        if (!inputs.length) {
            setState([]);
        }
        const subscriptions = inputs.map((input, i) => client.subscribeCollectionChanges(
            op, input, Number.POSITIVE_INFINITY, (newCollection) => {
                const filteredCollection = applyCollectionFilters(newCollection, filters);
                if (!isEqual(resultStates[i], filteredCollection, 2)) {
                    resultStates[i] = filteredCollection;
                    if (resultStates.every(isNotNully)) {
                        setState((resultStates as Array<Collection<S>>).slice());
                    }
                }
            },
        ));
        return () => {
            subscriptions.forEach((unsubscribe) => unsubscribe());
        };
    }, [
        client, op, getFingerprint(inputs), getFingerprint(filters),
    ]);
    return states as {[P in keyof I]: Collection<S>};
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
    return applyCollectionFilters(
        client.inquiryCollection(op, input), filters,
    );
}

function applyCollectionFilters<S, C extends Collection<S>>(collection: C, filters: Partial<S> | null | undefined): C {
    return !filters ? collection : {
        ...collection,
        resources: collection.resources.filter(
            (resource) => hasProperties(resource, filters),
        ),
    };
}

function listifyCollection<S>(collection: Collection<S>): List<S> {
    return [
        collection.isComplete ? collection.resources : null,
        collection.error,
        collection.isLoading,
    ];
}

function isValidationError(error: unknown) {
    return !!error && isErrorResponse(error) && error.statusCode === HttpStatus.BadRequest;
}
