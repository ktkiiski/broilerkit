/**
 * Maps each item in the given array to zero or more items,
 * returning them in a single flattened array of items.
 * @param items Items to map
 * @param callback Function that should expand each item in the array
 */
export function flatMap<T, R>(items: T[], callback: (item: T) => R[]): R[] {
    const results: R[] = [];
    for (const item of items) {
        results.push(...callback(item));
    }
    return results;
}

/**
 * Sorts the given array of values by a key attribute using the
 * given direction. Optionally also filters only values whose
 * attribute values are "before" or "after" of the given 'since' value
 * depending on the direction.
 */
export function order<T, K extends keyof T>(values: T[], ordering: K, direction: 'asc' | 'desc', since?: T[K]): T[] {
    return sort(values, (item) => item[ordering], direction, since);
}

/**
 * Sorts the given array of values by using the sorting value returned by the given
 * function for each item in the array, and using the given direction.
 * Optionally also filters only values whose
 * attribute values are "before" or "after" of the given 'since' value
 * depending on the direction.
 */
export function sort<T, V>(values: T[], iterator: (item: T, index: number, src: T[]) => V, direction: 'asc' | 'desc' = 'asc', since?: V): T[] {
    // NOTE: Because JavaScript sort is not stable, make it stable by including the index with each item
    let items = values.map((item, index, arr) => [item, iterator(item, index, arr), index] as [T, V, number]);
    if (since != null) {
        // Filter out items that should not be included to the final array
        items = items.filter(direction === 'asc'
            ? (item) => item[1] > since
            : (item) => item[1] < since,
        );
    }
    // Sort the items
    const factor = direction === 'asc' ? 1 : -1;
    items.sort(([, value1, index1], [, value2, index2]) => {
        if (value1 > value2) {
            return factor;
        }
        if (value1 < value2) {
            return -factor;
        }
        return (index1 - index2) * factor;
    });
    // Do not return the indexes or comparison values, just the actual items
    return items.map((item) => item[0]);
}

/**
 * Returns an array of items that exist in the first given
 * array but do NOT exist in the second array.
 */
export function difference<A, B>(a: A[], b: B[]): Array<Exclude<A, B>>;
export function difference<T>(a: T[], b: T[]): T[] {
    return a.filter((x) => b.indexOf(x) < 0);
}

/**
 * Returns an array of items that exist in the first given
 * array but do NOT exist in the second array. The given comparison
 * function is used to check if two items are equal.
 */
export function differenceBy<T, S>(a: T[], b: S[], iterator: (item: T | S) => any): T[] {
    const exclusions = b.map(iterator);
    return a.filter((x) => exclusions.indexOf(iterator(x)) < 0);
}

/**
 * Returns an array of unique items in the all
 * of the given arrays. Each distinct value will only
 * occur once in the returned array.
 */
export function union<T>(...arrays: T[][]): T[] {
    const result: T[] = [];
    for (const array of arrays) {
        for (const item of array) {
            if (result.indexOf(item) < 0) {
                result.push(item);
            }
        }
    }
    return result;
}
