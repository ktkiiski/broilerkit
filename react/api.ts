import { useState } from 'react';
import { combineLatest, Observable, of } from 'rxjs';
import { IntermediateCollection } from '../api';
import { Bindable, Client } from '../client';
import { ListOperation, Operation, RetrieveOperation } from '../operations';
import { Cursor } from '../pagination';
import { Serializer } from '../serializers';
import { Key } from '../utils/objects';
import { useClient } from './client';
import { useObservable } from './rxjs';

export function useResource<S, U extends Key<S>>(
    op: RetrieveOperation<S, U, any, any>,
    input: Pick<S, U>,
): S | null {
    return useResourceIf(op, input);
}

export function useResourceIf<S, U extends Key<S>>(
    op: RetrieveOperation<S, U, any, any>,
    input: Pick<S, U> | undefined | null,
): S | null {
    const client = useClient();
    return useBoundObservable(
        client, op, input,
        (i, model) => i ? model.observe(i) : null$,
        client && initializeValue(client, op, input) || null,
    );
}

export function useCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): IntermediateCollection<S> {
    return useCollectionIf(op, input) as IntermediateCollection<S>;
}

export function useCollectionIf<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F> | null | undefined,
): IntermediateCollection<S> | null {
    const client = useClient();
    const initialValue = client
        && initializeValue(client, op, input) as IntermediateCollection<S>
        || {items: [], isComplete: false}
    ;
    return useBoundObservable(
        client, op, input,
        (i, model) => i ? model.observe(i) : null$,
        initialValue,
    );
}

export function useList<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): S[] | null {
    const collection = useCollection(op, input);
    return useCompleteCollection(collection);
}

export function useListIf<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F> | null | undefined,
): S[] | null {
    const collection = useCollectionIf(op, input);
    return useCompleteCollection(collection);
}

export function useCollections<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    inputs: Array<Cursor<S, U, O, F>>,
): Array<IntermediateCollection<S>> {
    const client = useClient();
    // Try to read the very immediate value from the cache
    const initialValue = inputs.map((input) => (
        client && initializeValue(client, op, input) as IntermediateCollection<S> || {
            items: [],
            isComplete: false,
        }
    ));
    return useBoundObservable(
        client, op, inputs,
        (i, model) => !i.length ? of([]) : combineLatest(
            i.map((input) => model.observe(input)),
        ),
        initialValue,
    );
}

export function useOperation<T>(op: Bindable<T>): T {
    const client = useClient();
    return op.bind(client);
}

const null$ = of(null);

function useBoundObservable<I, T, R>(
    client: Client,
    op: Bindable<T>,
    input: I,
    observe: (input: I, model: T) => Observable<R>,
    initialValue: R,
    extraDeps: any[] = [],
): R {
    const model = op.bind(client);
    const fingerprint = getFingerprint(input);
    return useObservable(
        initialValue,
        () => observe(input, model),
        [client, fingerprint, ...extraDeps],
    );
}

function getFingerprint(obj: unknown) {
    if (typeof obj === 'object' && obj) {
        return JSON.stringify(obj);
    }
    return obj;
}

function useCompleteCollection<T>(collection: IntermediateCollection<T> | null): T[] | null {
    const [list, setList] = useState(collection && collection.isComplete ? collection.items : null);
    if (collection && collection.isComplete && collection.items !== list) {
        setList(collection.items);
    }
    return list;
}

function initializeValue(client: Client, op: Operation<any, any, any>, input: any) {
    const serializer = op.responseSerializer as Serializer;
    // Register to the client for server-side rendering
    client.registerRender(op, input);
    try {
        // Read from cache
        const url = op.route.compile(input).toString();
        const stateCache = client.stateCache$.getValue();
        const serializedValue = stateCache[url];
        const deserializedValue = serializer.deserialize(serializedValue);
        if (op.type !== 'list') {
            return deserializedValue;
        }
        // For lists the result is a page. Convert to an intermediate collection
        return {
            items: deserializedValue.results,
            isComplete: !deserializedValue.next,
        };
    } catch {
        // TODO: Expose errors to the hook users!
        return null;
    }
}
