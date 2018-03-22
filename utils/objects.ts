import {__assign, __rest} from 'tslib';

export type Diff<T extends string, U extends string> = ({[P in T]: P } & {[P in U]: never } & { [x: string]: never })[T];
export type Omit<T, K extends keyof T> = Pick<T, Diff<keyof T, K>>;
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Iterates through each own enumerable property of the given
 * object and calls the given callback for each of them.
 * @param obj Object to iterate
 * @param iterator Function to be called for each key
 */
export function forEachKey<T>(obj: T, iterator: (key: keyof T, value: T[keyof T]) => void): void {
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
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
export function mapObject<T, R>(obj: T, iterator: (value: T[keyof T], key: keyof T, obj: T) => R): R[] {
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
    forEachKey(obj, (key, value) => {
        result[key] = iterator(value, key, obj);
    });
    return result;
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
            result[pair[0]] = pair[1];
        }
    });
    return result as {[P in K]: V};
}

/**
 * Returns the keys of the given object as an array.
 * @param obj Object whose keys are returned
 */
export function keys<T>(obj: T): Array<keyof T> {
    const keyArray: Array<keyof T> = [];
    forEachKey(obj, (key) => keyArray.push(key));
    return keyArray;
}

/**
 * Returns the values of each of the key of the given object as an array.
 * @param obj Object whose values are returned
 */
export function values<T>(obj: T): Array<T[keyof T]> {
    const valueArray: Array<T[keyof T]> = [];
    forEachKey(obj, (_, value) => valueArray.push(value));
    return valueArray;
}

export type KeyValuePair<T> = {[P in keyof T]: [P, T[P]]}[keyof T];

/**
 * Returns the item pairs of the given object as an array.
 * Each pair is an array of exactly two values: [key, value]
 * @param obj Object whose items are returned.
 */
export function toPairs<T>(obj: T): Array<KeyValuePair<T>> {
    const valueArray: Array<KeyValuePair<T>> = [];
    forEachKey(obj, (key, value) => valueArray.push([key, value]));
    return valueArray;
}

/**
 * Picks only the given keys of the given object.
 */
export function pick<T, K extends keyof T>(obj: T, props: K[]): Pick<T, K> {
    const output = {} as Pick<T, K>;
    for (const key of props) {
        if (obj.hasOwnProperty(key)) {
            output[key] = obj[key];
        }
    }
    return output;
}

/**
 * Picks every other attribute but the given keys of the given object.
 */
export function omit<T, K extends keyof T>(obj: T, props: K[]): Omit<T, K> {
    return __rest(obj, props);
}

/**
 * Returns an object whose all attributes are assigned from the given objects.
 */
export function spread(): {};
export function spread<A>(obj1: A): A;
export function spread<A, B>(obj1: A, obj2: B): A & B;
export function spread<A, B, C>(obj1: A, obj2: B, obj3: C): A & B & C;
export function spread<A, B, C, D>(obj1: A, obj2: B, obj3: C, obj4: D): A & B & C & D;
export function spread<T>(obj1: T, ...obj2: T[]): T;
export function spread(...args: any[]): any {
    return __assign({}, ...args);
}
