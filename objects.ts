import hasOwnProperty from 'immuton/hasOwnProperty';
import type { Key } from 'immuton/types';

/**
 * Iterates through each own enumerable property of the given
 * object and calls the given callback for each of them.
 * @param obj Object to iterate
 * @param iterator Function to be called for each key
 */
export function forEachKey<T>(obj: T, iterator: (key: Key<T>, value: T[Key<T>]) => void): void {
    // eslint-disable-next-line no-restricted-syntax
    for (const key in obj) {
        if (hasOwnProperty(obj, key) && typeof key === 'string') {
            iterator(key, obj[key]);
        }
    }
}

/**
 * Returns the string keys of the given object as an array.
 * @param obj Object whose keys are returned
 */
export function keys<T>(obj: T): Key<T>[] {
    const keyArray: Key<T>[] = [];
    forEachKey(obj, (key) => keyArray.push(key));
    return keyArray;
}
