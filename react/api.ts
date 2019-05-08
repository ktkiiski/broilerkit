import { useEffect, useState } from 'react';
import { CollectionQuery, Operation, ResourceQuery } from '../models';
import { useFirestore } from './firebase';

// TODO: Excplicit error type!
type Resource<T> = [T | null, any, boolean];

// TODO: More explicit typing for the error
type List<S> = [S[], any | null, boolean];

export function useResource<S>(
    query: ResourceQuery<S>,
): Resource<S> {
    const firestore = useFirestore();
    // TODO: Get the initial state from SSR-provided cache
    const [state, setState] = useState([null, null, true] as Resource<S>);
    const fingerprint = getFingerprint(query.input);
    const isValid = !query.validationError;
    useEffect(() => {
        if (isValid) {
            return query.subscribe(firestore, (resource) => {
                setState([resource, null, false]);
            }, (error) => {
                setState([null, error, false]);
            });
        }
    }, [firestore, fingerprint, isValid]);
    return state;
}

export function useList<S>(
    query: CollectionQuery<S>,
): List<S> {
    const {input, ordering, direction, limit} = query;
    const firestore = useFirestore();
    // TODO: Get the initial state from SSR-provided cache
    const [state, setState] = useState<List<S>>([[], null, true]);
    const isValid = !query.validationError;
    const fingerprint = getFingerprint(input);
    useEffect(() => {
        return query.subscribe(
            firestore,
            (resources) => {
                setState([resources, null, false]);
            },
            (error) => {
                setState([[], error, false]);
            },
        );
    }, [firestore, fingerprint, ordering, direction, limit, isValid]);
    return state;
}

export function useLists<S extends any[]>(
    queries: { [P in keyof S]: CollectionQuery<S[P]> },
): { [P in keyof S]: List<S[P]> } {
    const firestore = useFirestore();
    // TODO: Get the initial states from SSR-provided cache
    const [states, setState] = useState(
        queries.map(() => [[], null, true] as List<any>),
    );
    const fingerprint = getFingerprint(queries.map(
        ({input, ordering, direction, limit}) => [input, ordering, direction, limit],
    ));
    useEffect(() => {
        const resultStates = states.slice();
        const subscriptions = queries.map((query, i) => query.subscribe(
            firestore,
            (resources) => {
                resultStates[i] = [resources, null, false];
                setState(resultStates.slice());
            },
            (error) => {
                resultStates[i] = [[], error, false];
                setState(resultStates.slice());
            },
        ));
        return () => {
            subscriptions.forEach((unsubscribe) => unsubscribe());
        };
    }, [fingerprint]);
    return states as { [P in keyof S]: List<S[P]> };
}

export function useOperation<T, Q>(op: Operation<T, Q>): (query: Q) => Promise<T> {
    const firestore = useFirestore();
    return async (query) => op.run(firestore, query);
}

function getFingerprint(obj: unknown) {
    if (typeof obj === 'object' && obj) {
        return JSON.stringify(obj);
    }
    return obj;
}
