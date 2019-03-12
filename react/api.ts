import { useState } from 'react';
import { combineLatest, never, Observable, of } from 'rxjs';
import { take } from 'rxjs/operators';
import { IntermediateCollection } from '../api';
import { Bindable, Client } from '../client';
import { ListOperation, Operation, RetrieveOperation } from '../operations';
import { Cursor } from '../pagination';
import { Serializer } from '../serializers';
import { Key } from '../utils/objects';
import { useUserId } from './auth';
import { useClient, useWithClient } from './client';
import { useObservable } from './rxjs';

export function useResource<S, U extends Key<S>>(
    op: RetrieveOperation<S, U, any, any>,
    input: Pick<S, U>,
): S | null {
    const client = useClient();
    return useBoundObservable(
        op, input,
        (i, model) => model.observe(i),
        client && initializeValue(client, op, input) || null,
    );
}

export function useResourceWithAuth<S, U extends Key<S>, B extends U>(
    op: RetrieveOperation<S, U, any, B>,
    input: Pick<S, Exclude<U, B>>,
): S | null {
    const client = useClient();
    return useBoundObservableWithUserId(
        op, input,
        (i, model) => model.observe(i as any),
        client && initializeValue(client, op, input),
    ) || null;
}

export function useCollection<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): IntermediateCollection<S> {
    const client = useClient();
    const initialValue = client
        && initializeValue(client, op, input) as IntermediateCollection<S>
        || {items: [], isComplete: false}
    ;
    return useBoundObservable(
        op, input,
        (i, model) => model.observe(i),
        initialValue,
    );
}

export function useCollectionWithAuth<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B extends U>(
    op: ListOperation<S, U, O, F, any, B>,
    input: Cursor<S, Exclude<U, B>, O, F>,
): IntermediateCollection<S> {
    const client = useClient();
    return useBoundObservableWithUserId(
        op, input,
        (i, model) => model.observe(i as any),
        client && initializeValue(client, op, input) as IntermediateCollection<S>,
    ) || {items: [], isComplete: false};
}

export function useCollectionOnce<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): IntermediateCollection<S> {
    const client = useClient();
    const initialValue = client
        && initializeValue(client, op, input) as IntermediateCollection<S>
        || {items: [], isComplete: false}
    ;
    return useBoundObservable(
        op, input,
        (i, model) => model.observe(i).pipe(take(1)),
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

export function useListOnce<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): S[] | null {
    const collection = useCollectionOnce(op, input);
    return useCompleteCollection(collection);
}

export function useListWithAuth<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B extends U>(
    op: ListOperation<S, U, O, F, any, B>,
    input: Cursor<S, Exclude<U, B>, O, F>,
): S[] | null {
    const collection = useCollectionWithAuth(op, input);
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
        op, inputs,
        (i, model) => !i.length ? of([]) : combineLatest(
            i.map((input) => model.observe(input)),
        ),
        initialValue,
    );
}

export function useOperation<T, P extends any[] = [], R = void>(op: Bindable<T>, exec: (model: T, ...args: P) => R): (...args: P) => R {
    return useWithClient((client, ...args: P) => {
        const model = op.bind(client);
        return exec(model, ...args);
    });
}

const nothing$ = never();

function useBoundObservable<I, T, R>(
    op: Bindable<T> & Operation<any, any, any>,
    input: I,
    observe: (input: I, model: T) => Observable<R>,
    initialValue: R,
    extraDeps: any[] = [],
): R {
    const client = useClient();
    const fingerprint = getFingerprint(input);
    return useObservable(
        initialValue,
        () => {
            // No client, no subscription
            if (!client) {
                return nothing$;
            }
            const model = op.bind(client);
            return observe(input, model);
        },
        [client, fingerprint, ...extraDeps],
    );
}

function useBoundObservableWithUserId<I, T, R, B extends string>(
    op: Bindable<T> & Operation<any, any, any> & {userIdAttribute: string},
    input: I,
    observe: (input: I & Record<B, string>, model: T) => Observable<R>,
    initialValue: R,
    extraDeps: any[] = [],
): R | null {
    const {userIdAttribute} = op;
    if (!userIdAttribute) {
        throw new Error(`User ID attribute is undefined.`);
    }
    const userId = useUserId();
    return useBoundObservable(
        op,
        // Input with the user ID property, which might be null
        {...input, [userIdAttribute]: userId},
        (i, model) => (
            // If user ID is null, then always result in null
            i[userIdAttribute] == null ? of(null) : observe(i as I & Record<B, string>, model)
        ),
        initialValue,
        [userId, ...extraDeps],
    );
}

function getFingerprint(obj: unknown) {
    if (typeof obj === 'object' && obj) {
        return JSON.stringify(obj);
    }
    return obj;
}

function useCompleteCollection<T>(collection: IntermediateCollection<T>): T[] | null {
    const [list, setList] = useState(collection.isComplete ? collection.items : null);
    if (collection.isComplete && collection.items !== list) {
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
