import {__assign, __rest} from 'tslib';
import { isEqual } from './compare';

export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<T>;
export type Require<T, K extends keyof T> = Pick<T, K> & Partial<T>;
export type Nullable<T> = {[P in keyof T]: T[P] | null};
export type Key<T> = keyof T & string;
export type Exact<T, R, E = 'Object must only have allowed properties'> = T & (Exclude<keyof T, keyof R> extends never ? T : E);

/**
 * Resolves to keys of an object that match the given Condition type.
 * Source: https://medium.com/dailyjs/typescript-create-a-condition-based-subset-types-9d902cea5b8c
 */
export type FilteredKeys<T, Condition> = { [P in keyof T]: T[P] extends Condition ? P : never }[keyof T];
/**
 * Filters keys of an object so that they must match the given Condition type.
 * Source: https://medium.com/dailyjs/typescript-create-a-condition-based-subset-types-9d902cea5b8c
 */
export type FilteredValues<T, Condition> = Pick<T, FilteredKeys<T, Condition>>;

/**
 * Resolves to keys of an object that do NOT match the given Condition type.
 * Source: https://medium.com/dailyjs/typescript-create-a-condition-based-subset-types-9d902cea5b8c
 */
export type ExcludedKeys<T, Condition> = { [P in keyof T]: T[P] extends Condition ? never : P }[keyof T];
/**
 * Filters keys of an object so that they do NOT match the given Condition type.
 * Source: https://medium.com/dailyjs/typescript-create-a-condition-based-subset-types-9d902cea5b8c
 */
export type ExcludedValues<T, Condition> = Pick<T, ExcludedKeys<T, Condition>>;

/**
 * Iterates through each own enumerable property of the given
 * object and calls the given callback for each of them.
 * @param obj Object to iterate
 * @param iterator Function to be called for each key
 */
export function forEachKey<T>(obj: T, iterator: (key: Key<T>, value: T[Key<T>]) => void): void {
    for (const key in obj) {
        if (hasOwnStringProperty(obj, key)) {
            iterator(key, obj[key]);
        }
    }
}

/**
 * Iterates through each own enumerable string property of the given
 * object and calls the given callback for each of them.
 * @param obj Object to iterate
 * @param iterator Function to be called for each key
 */
export function forEachProperty<T>(obj: T, iterator: (key: keyof T, value: T[keyof T]) => void): void {
    for (const key in obj) {
        if (hasOwnProperty(obj, key)) {
            iterator(key, obj[key]);
        }
    }
}

/**
 * Converts an object to an array of items by calling the given
 * iterator function for each key and value, and constructing a new
 * array from the returned values.
 * @param obj Object whose values are mapped
 * @param iterator Function that returns new value for each key
 */
export function mapObject<T, R>(obj: T, iterator: (value: T[Key<T>], key: Key<T>, obj: T) => R): R[] {
    const result: R[] = [];
    forEachKey(obj, (key, value) => {
        result.push(iterator(value, key, obj));
    });
    return result;
}

/**
 * Maps each value for each key of an object to a new value,
 * as returned by the given function that is called for each key.
 * @param obj Object whose values are mapped
 * @param iterator Function that returns new value for each key
 */
export function transformValues<T, R>(obj: T, iterator: (value: T[keyof T], key: keyof T, obj: T) => R): {[P in keyof T]: R} {
    const result = {} as {[P in keyof T]: R};
    forEachProperty(obj, (key, value) => {
        result[key] = iterator(value, key, obj);
    });
    return result;
}

/**
 * Maps each key of an object to a new key, as returned by the given
 * function that is called for each key.
 * @param obj Object whose values are mapped
 * @param iterator Function that returns new value for each key
 */
export function transformKeys<T, R extends string>(obj: T, iterator: (key: Key<T>, value: T[Key<T>], obj: T) => R): {[P in R]: T[Key<T>]} {
    const result = {} as {[key: string]: T[Key<T>]};
    forEachKey(obj, (key, value) => {
        const newKey: string = iterator(key, value, obj);
        result[newKey] = value;
    });
    return result as {[P in R]: T[Key<T>]};
}

/**
 * Creates an object by mapping each item in the given array to
 * pairs of keys and values. The given iterator function is called
 * for each item in the array and it should return the key-value pair
 * as a two-item array. If it returns undefined, then the item will
 * be omitted from the result object.
 */
export function buildObject<T, V, K extends string>(source: T[], iterator: (item: T, index: number, src: T[]) => [K, V] | void): {[P in K]: V} {
    const result: {[key: string]: V} = {};
    source.forEach((item, index, src) => {
        const pair = iterator(item, index, src);
        if (pair) {
            result[pair[0] as string] = pair[1];
        }
    });
    return result as {[P in K]: V};
}

/**
 * Returns the string keys of the given object as an array.
 * @param obj Object whose keys are returned
 */
export function keys<T>(obj: T): Array<Key<T>> {
    const keyArray: Array<Key<T>> = [];
    forEachKey(obj, (key) => keyArray.push(key));
    return keyArray;
}

export type KeyValuePair<T> = {[P in Key<T>]: [P, T[P]]}[Key<T>];

/**
 * Returns the item pairs of the given object as an array.
 * Each pair is an array of exactly two values: [key, value]
 * Only string keys are included.
 * @param obj Object whose items are returned.
 */
export function toPairs<T>(obj: T): Array<KeyValuePair<T>> {
    const valueArray: Array<KeyValuePair<T>> = [];
    forEachKey(obj, (key, value) => valueArray.push([key, value]));
    return valueArray;
}

/**
 * Picks only the given keys of the given object.
 * Also ignores everything else than string attributes.
 */
export function pick<T, K extends keyof T>(obj: T, props: K[]): Pick<T, Extract<K, string>> {
    const output = {} as Pick<T, K>;
    for (const key of props) {
        if (hasOwnStringProperty(obj, key)) {
            output[key] = obj[key];
        }
    }
    return output;
}

/**
 * Picks only the keys of the given object matching the criteria.
 * Also ignores everything else than string attributes.
 */
export function pickBy<T, V>(obj: T, fn: (key: string, value: any) => value is V): FilteredValues<T, V>;
export function pickBy<T, K extends keyof T & string>(obj: T, fn: (key: string, value: any) => key is K): Pick<T, K>;
export function pickBy<T>(obj: T, fn: (key: string, value: any) => boolean): Partial<T>;
export function pickBy<T>(obj: T, fn: (key: string, value: any) => boolean): Partial<T> {
    const output = {} as Partial<T>;
    forEachKey(obj, (key, value) => {
        if (fn(key, value)) {
            output[key] = value;
        }
    });
    return output;
}

export function omitUndefined<V>(obj: {[key: string]: V}): {[key: string]: Exclude<V, undefined>};
export function omitUndefined<T>(obj: T): ExcludedValues<T, undefined>;
export function omitUndefined<T>(obj: T): ExcludedValues<T, undefined> {
    const output: any = {};
    forEachProperty(obj, (key, value) => {
        if (typeof value !== 'undefined') {
            output[key] = value;
        }
    });
    return output;
}

/**
 * Picks every other attribute but the given keys of the given object.
 * Also ignores everything else than string attributes.
 */
export function omit<T, K extends Key<T>>(obj: T, props: K[]): Omit<T, K> {
    return __rest(obj, props as string[]);
}

/**
 * Determines which properties at the 2nd parameter has
 * different values than the 1st parameter, and returns an
 * object with those properties.
 * @param oldObj the old state of an object
 * @param newObj the new state of an object
 */
export function getObjectChanges<T>(oldObj: {[key: string]: T}, newObj: {[key: string]: T}, depth?: number): {[key: string]: T};
export function getObjectChanges<T>(oldObj: T, newObj: T, depth?: number): Partial<T>;
export function getObjectChanges<T>(oldObj: T, newObj: T, depth?: number): Partial<T> {
    const result: Partial<T> = {};
    forEachProperty(newObj, (key, value) => {
        if (!isEqual(value, oldObj[key], depth)) {
            result[key] = value;
        }
    });
    return result;
}

export function hasOwnStringProperty<T>(obj: T, propName: string | number | symbol): propName is Key<T> {
    return typeof propName === 'string' && hasOwnProperty(obj, propName);
}

export function hasOwnProperty<T>(obj: T, propName: string | number | symbol): propName is keyof T {
    return Object.prototype.hasOwnProperty.call(obj, propName);
}
