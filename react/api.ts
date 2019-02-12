import { combineLatest, never, Observable, of } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';
import { ListOperation, RetrieveOperation } from '../api';
import { Bindable } from '../client';
import { Cursor } from '../pagination';
import { Key, Omit } from '../utils/objects';
import { useClient, useWithClient } from './client';
import { useObservable } from './rxjs';

export function useResource<S, U extends Key<S>>(
    op: RetrieveOperation<S, U, any, any>,
    input: Pick<S, U>,
): S | null {
    return useBoundObservable(op, input, (i, model) => model.observe(i));
}

export function useResourceWithAuth<S, U extends Key<S>, B extends U>(
    op: RetrieveOperation<S, U, any, B>,
    input: Pick<S, Exclude<U, B>>,
): S | null {
    return useBoundObservable(op, input, (i, model) => model.observeWithUser(i));
}

export function useList<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): S[] | null {
    return useBoundObservable(op, input, (i, model) => model.observeAll(i));
}

export function useListOnce<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Cursor<S, U, O, F>,
): S[] | null {
    return useBoundObservable(op, input, (i, model) => model.observeAll(i).pipe(take(1)));
}

export function useListWithAuth<S, U extends Key<S>, O extends Key<S>, F extends Key<S>, B extends U>(
    op: ListOperation<S, U, O, F, any, any>,
    input: Omit<Cursor<S, U, O, F>, B>,
): S[] | null {
    return useBoundObservable(
        op, input, (i, model) => model.observeAllWithUser(i),
    );
}

export function useListMany<S, U extends Key<S>, O extends Key<S>, F extends Key<S>>(
    op: ListOperation<S, U, O, F, any, any>,
    inputs: Array<Cursor<S, U, O, F>>,
): S[][] | null {
    return useBoundObservable(
        op, inputs, (i, model) => !i.length ? of([]) : combineLatest(
            i.map((input) => model.observe(input).pipe(
                filter((collection) => collection.isComplete),
                map((collection) => collection.items),
            )),
        ),
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
    op: Bindable<T>,
    input: I,
    observe: (input: I, model: T) => Observable<R>,
    extraDeps: any[] = [],
): R | null {
    const client = useClient();
    const fingerprint = getFingerprint(input);
    return useObservable(
        null,
        () => {
            // No client (yet), no subscription
            if (!client) {
                return nothing$;
            }
            const model = op.bind(client);
            return observe(input, model);
        },
        [client, fingerprint, ...extraDeps],
    );
}

function getFingerprint(obj: unknown) {
    if (typeof obj === 'object' && obj) {
        return JSON.stringify(obj);
    }
    return obj;
}
