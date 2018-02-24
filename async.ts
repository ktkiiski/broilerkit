export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export async function *buffer<T>(iterator: AsyncIterable<T>, bufferSize: number): AsyncIterableIterator<T[]> {
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

export async function toArray<T>(iterator: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterator) {
        items.push(item);
    }
    return items;
}

export async function *concatAsync<T>(...iterables: Array<AsyncIterable<T>>) {
    for (const iterator of iterables) {
        yield *iterator;
    }
}

export function mergeAsync<T>(...iterables: Array<AsyncIterable<T>>): AsyncIterableIterator<T> {
    return generate(({next, error, complete}) => {
        const promises = iterables.map(async (iterable) => {
            for await (const item of iterable) {
                next(item);
            }
        });
        Promise.all(promises).then(complete, error);
    });
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
