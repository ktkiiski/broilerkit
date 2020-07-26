/* eslint-disable @typescript-eslint/no-explicit-any */
class SharedAsyncIterable<T> implements AsyncIterable<T> {
    private buffer: Promise<IteratorResult<T>>[] = [];

    constructor(private iterator: AsyncIterator<T>) {}

    public [Symbol.asyncIterator](): AsyncIterator<T> {
        return new SharedIterator(this.buffer, this.iterator);
    }
}

class SharedIterator<T, R, N> implements AsyncIterator<T, R, N> {
    private index = 0;

    constructor(private buffer: Promise<IteratorResult<T, R>>[], private iterator: AsyncIterator<T, R, N>) {}

    public next(value?: any): Promise<IteratorResult<T, R>> {
        // TODO: Do not cache anything called after completion
        this.index += 1;
        const { index, buffer } = this;
        let promise = buffer[index];
        if (promise == null) {
            promise = this.iterator.next(value);
            buffer[index] = promise;
            // TODO: Forget the reference to the original iterator when complete!
        }
        return promise;
    }
}

/**
 * Wraps an iterator so that it can be iterated multiple times,
 * even at the same time, consuming the original iterator once,
 * caching the results, and yielding them to any new iterators.
 */
export function shareIterator<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
    return new SharedAsyncIterable(iterator);
}

export function iterate<T>(iterable: Iterable<T> | AsyncIterable<T>): Iterator<T> | AsyncIterator<T> {
    if (Symbol.asyncIterator in iterable) {
        return (iterable as AsyncIterable<T>)[Symbol.asyncIterator]();
    }
    return (iterable as Iterable<T>)[Symbol.iterator]();
}
