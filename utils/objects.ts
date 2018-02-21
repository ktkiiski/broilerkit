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
 * Returns the keys of the given object as an array.
 * @param obj Object whose keys are returned
 */
export function keys<T>(obj: T): Array<keyof T> {
    const keyArray: Array<keyof T> = [];
    forEachKey(obj, (key) => keyArray.push(key));
    return keyArray;
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