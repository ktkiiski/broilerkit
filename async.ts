import compare from 'immuton/compare';
import { iterate } from './iteration';

export function wait(ms?: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms ?? 0);
    });
}

export function asap<T = void>(callback?: () => void): Promise<void>;
export function asap<T = void>(callback?: () => T): Promise<T> {
    const promise = Promise.resolve() as Promise<any>;
    return callback ? promise.then(callback) : promise;
}

export function timeout<T>(maxDuration: number, task: Promise<T>, message: string = 'Operation timed out'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error(message)), maxDuration);
        task.then(resolve, reject).finally(() => clearTimeout(timeoutId));
    });
}

export async function *chunkify<T>(iterator: AsyncIterable<T> | Iterable<T>, bufferSize: number): AsyncIterableIterator<T[]> {
    let items: T[] = [];
    for await (const item of iterator) {
        items.push(item);
        if (items.length >= bufferSize) {
            yield items;
            items = [];
        }
    }
    if (items.length) {
        yield items;
    }
}

export async function toArray<T>(iterator: AsyncIterable<T> | Iterable<T> | T[]): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterator) {
        items.push(item);
    }
    return items;
}

export async function toFlattenArray<T>(iterator: AsyncIterable<T[]>): Promise<T[]> {
    const items: T[] = [];
    for await (const chunk of iterator) {
        items.push(...chunk);
    }
    return items;
}

export async function *mapAsync<T, R>(iterable: AsyncIterable<T>, iteratee: (item: T, index: number) => R) {
    let index = 0;
    for await (const item of iterable) {
        yield iteratee(item, index);
        index += 1;
    }
}

export async function *filterAsync<T>(iterable: AsyncIterable<T>, iteratee: (item: T, index: number) => boolean): AsyncIterableIterator<T> {
    let index = 0;
    for await (const item of iterable) {
        if (iteratee(item, index)) {
            yield item;
        }
        index += 1;
    }
}

export async function *concatAsync<T>(...iterables: AsyncIterable<T>[]) {
    for (const iterator of iterables) {
        yield *iterator;
    }
}

export function mergeAsync<T>(...iterables: AsyncIterable<T>[]): AsyncIterableIterator<T> {
    return generate(({next, error, complete}) => {
        const promises = iterables.map(async (iterable) => {
            for await (const item of iterable) {
                next(item);
            }
        });
        Promise.all(promises).then(complete, error);
    });
}

export async function *mergeSortedAsync<T, K extends keyof T>(iterables: AsyncIterable<T>[], ordering: K, direction: 'asc' | 'desc'): AsyncIterableIterator<T> {
    const iterators = iterables.map((iterable) => iterable[Symbol.asyncIterator]());
    const nextPromises: Promise<IteratorResult<T>>[] = iterators.map((iterator) => iterator.next());
    const len = iterables.length;
    while (true) {
        const nextResults = await Promise.all(nextPromises);
        let minIndex: number | undefined;
        let minItem!: T;
        for (let index = 0; index < len; index += 1) {
            const result = nextResults[index];
            if (!result.done) {
                const item = result.value;
                if (minIndex === undefined || compare(item[ordering], minItem[ordering], direction) < 0) {
                    minIndex = index;
                    minItem = item;
                }
            }
        }
        if (minIndex === undefined) {
            break;
        }
        yield minItem;
        nextPromises[minIndex] = iterators[minIndex].next();
    }
}

export async function *flatMapAsync<T, R>(iterable: AsyncIterable<T>, callback: (item: T, index: number) => IterableIterator<R> | AsyncIterable<R> | R[] | undefined): AsyncIterableIterator<R> {
    let index = 0;
    for await (const sourceItem of iterable) {
        const targetItems = callback(sourceItem, index);
        if (targetItems) {
            yield *targetItems;
        }
        index += 1;
    }
}

export async function reduceAsync<T, R>(iterable: AsyncIterable<T>, callback: (accumulator: R, currentValue: T) => R, ...initialValues: R[]): Promise<R> {
    let h = false;
    let value!: R | T;

    if (initialValues.length > 0) {
        value = initialValues[0];
        h = true;
    }
    for await (const item of iterable) {
        if (h) {
            value = callback(value as R, item);
        } else {
            value = item;
            h = true;
        }
    }
    if (!h) {
        throw new TypeError('Reduce of empty iterable with no initial value');
    }
    return value as R;
}

export async function *toAsync<T>(values: T[] | Iterable<T>) {
    for (const value of values) {
        yield value;
    }
}

export interface ExecutorParams<T> {
    next(value: T): void;
    complete(): void;
    error(value: any): void;
}

export async function *generate<T>(executor: (params: ExecutorParams<T>) => void | (() => void)): AsyncIterableIterator<T> {
    type Token = {done: true} | {done: false, value: T};
    const pendingTokens: Token[] = [];
    let nextResolve!: (value: Token) => void;
    let nextReject!: (error: any) => void;
    let nextPromise!: Promise<any>;
    // tslint:disable-next-line:no-shadowed-variable
    function iterate() {
        nextPromise = new Promise((resolve, reject) => {
            nextResolve = (token: Token) => {
                pendingTokens.push(token);
                iterate();
                resolve();
            };
            nextReject = reject;
        });
    }
    iterate();
    const terminate = executor({
        next: (value: T) => { nextResolve({done: false, value}); },
        complete: () => { nextResolve({done: true}); },
        error: (error: any) => { nextReject(error); },
    });
    try {
        while (true) {
            await nextPromise;
            let nextToken: Token | undefined;

            // tslint:disable-next-line:no-conditional-assignment
            while (nextToken = pendingTokens.shift()) {
                if (nextToken.done) {
                    return;
                } else {
                    yield nextToken.value;
                }
            }
        }
    } finally {
        if (terminate) {
            terminate();
        }
    }
}

type WorkerResult<T> = { done: true } | { done: false, value: T };

/**
 * Maps and flattens the values from the given iterable running them
 * through a processing callback concurrently so that there is maximum
 * of the given number of results being processed concurrently.
 * @param maxConcurrency maximum number of concurrently running tasks
 * @param iterable Source iterables to process
 * @param callback Processor for each value
 */
export async function *flatMapAsyncParallel<T, R>(maxConcurrency: number, iterable: Iterable<T> | AsyncIterable<T>, callback: (item: T, index: number) => IterableIterator<R> | AsyncIterable<R> | R[] | undefined): AsyncIterableIterator<R> {
    const iterator = iterate(iterable);
    let startedCount = 0;
    let runningCount = 0;
    const pendingTasks: Promise<WorkerResult<R[]>>[] = [];

    async function process(next: IteratorResult<T> | Promise<IteratorResult<T>>): Promise<WorkerResult<R[]>> {
        let runNext = false;
        try {
            const { done, value } = await next;
            if (done) {
                return { done };
            }
            const callbackResult = callback(value, startedCount);
            startedCount += 1;
            runNext = true;
            if (!callbackResult) {
                return { done: false, value: [] };
            }
            const items = await toArray(callbackResult);
            return { done: false, value: items };
        } finally {
            runningCount -= 1;
            if (runNext) {
                run();
            }
        }
    }

    function run() {
        while (runningCount < maxConcurrency) {
            runningCount += 1;
            const next = process(iterator.next());
            pendingTasks.push(next);
        }
    }

    run();
    while (true) {
        // Promise that resolves when the next pending task resolves,
        // or if any of the running tasks fail.
        const nextResult = await Promise.race(pendingTasks.map(async (task, taskIndex) => {
            if (taskIndex > 0) {
                // Not next in line, but still catch errors
                return await errorsOnly(task);
            }
            // Otherwise await normally
            return task;
        }));
        if (nextResult.done) {
            // Everything completed
            return;
        }
        // Yield the results
        for (const value of nextResult.value) {
            yield value;
        }
        // Remove from the pending tasks
        pendingTasks.shift();
    }
}

export function mapAsyncParallel<T, R>(maxConcurrency: number, iterable: Iterable<T> | AsyncIterable<T>, callback: (item: T, index: number) => Promise<R>) {
    return flatMapAsyncParallel(maxConcurrency, iterable, async function*(item, index) {
        yield await callback(item, index);
    });
}

/**
 * Wraps the given promise so that it never resolves, but any
 * errors are still passed through.
 * @param promise promise whose result will be ignored
 */
export function errorsOnly(promise: Promise<any>): Promise<never> {
    return new Promise((_, reject) => {
        promise.catch((error) => reject(error));
    });
}

interface Deferred<T> {
    resolve: (value: T) => void;
    reject: (error: any) => void;
    promise: Promise<T>;
}

export function deferred<T>(): Deferred<T> {
    const dfr = {} as any;
    dfr.promise = new Promise((resolve, reject) => {
        dfr.resolve = resolve;
        dfr.reject = reject;
    });
    return dfr;
}
