import { combineLatest, from, Observable, of, Subscribable } from 'rxjs';
import { map } from 'rxjs/operators';
import { buildObject, mapObject } from './utils/objects';

/**
 * Converts an iterable to an Observable.
 * The iterator will be consumed only while the Observable is being subscribed.
 *
 * @param iterable An iterable to convert to an Observable
 */
export function observeIterable<T>(iterable: AsyncIterable<T> | Iterable<T>): Observable<T> {
    return new Observable<T>((subscriber) => {
        let closed = false;
        (async () => {
            try {
                for await (const value of iterable) {
                    if (closed) {
                        return;
                    }
                    subscriber.next(value);
                }
            } catch (error) {
                subscriber.error(error);
            }
            subscriber.complete();
        })();
        return () => { closed = true; };
    });
}

/**
 * Converts an async iterator to an Observable.
 * Iterator is consumed only while the Observable is being subscribed.
 * If unsubscribed, the iterator will be paused, and resumed when re-subscribed.
 * IMPORTANT: Avoid having more than one subscriber, because having more than
 * one subscriber will result in skipped emits! It is recommended to use multicasting
 * for the returned Observable to avoid these issues!
 *
 * @param iterator Async iterator to convert to an Observable
 */
export function observeAsyncIterator<T>(iterator: AsyncIterator<T>): Observable<T> {
    let promise: Promise<IteratorResult<T>> | null = null;
    return new Observable<T>((subscriber) => {
        let closed = false;
        promise = promise || iterator.next();

        function handleNext(result: IteratorResult<T>) {
            if (!closed) {
                if (result.done) {
                    subscriber.complete();
                } else {
                    subscriber.next(result.value);
                    promise = iterator.next();
                    promise.then(handleNext, handleError);
                }
            }
        }
        function handleError(error: any) {
            subscriber.error(error);
        }
        promise.then(handleNext, handleError);
        return () => { closed = true; };
    });
}

/**
 * Converts an object, which contains either values OR observables of values,
 * to an observable that emits objects with actual, latest values.
 * @param input Object whose values are either regular values or observables
 */
export function observeValues<I>(input: {[P in keyof I]: I[P] | Subscribable<I[P]>}): Observable<I> {
    let observableCount = 0;
    const items$ = mapObject(input, (value: any, key: string) => {
        if (typeof value === 'object' && 'subscribe' in value && typeof value.subscribe === 'function') {
            observableCount += 1;
            return from<any>(value).pipe(
                // tslint:disable-next-line:no-shadowed-variable
                map((value) => ({key, value})),
            );
        }
        return of({key, value});
    });
    // If no observables as values, we can omit the original input as-is
    if (!observableCount) {
        return of(input as I);
    }
    return combineLatest<{key: string, value: any}, I>(
        items$, (...items) => buildObject(items, ({key, value}) => [key, value]) as I,
    );
}
