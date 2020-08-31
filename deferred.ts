type Resolver<R> = (value: R | PromiseLike<R>) => void;
type Rejecter = (reason?: unknown) => void;

export interface Deferred<R> {
    promise: Promise<R>;
    resolve: Resolver<R>;
    reject: Rejecter;
}

export function defer<R>(): Deferred<R> {
    const deferred: Partial<Deferred<R>> = {};
    const promise = new Promise<R>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
    });
    deferred.promise = promise;
    return deferred as Deferred<R>;
}
