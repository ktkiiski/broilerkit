export interface Cache {
    [key: string]: any;
}
export function cached<T>(cache: Cache, key: string, fn: () => Promise<T>): Promise<T> {
    let promise = cache[key] as Promise<T> | undefined;
    if (!promise || typeof promise.then !== 'function') {
        promise = fn();
        cache[key] = promise;
        // Remove from cache on any error
        promise.catch(() => {
            if (cache[key] === promise) {
                delete cache[key];
            }
        });
    }
    return promise;
}
