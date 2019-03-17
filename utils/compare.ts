import { hasOwnProperty, keys } from './objects';

const isArray = Array.isArray;

/**
 * Compares the two given values with deep comparison
 * and returns whether or not they are equal.
 *
 * @param a First value to compare
 * @param b Second value to compare
 */
export function isEqual<T, S>(a: T, b: S, depth?: number): boolean;
export function isEqual(a: any, b: any, depth = Number.POSITIVE_INFINITY): boolean {
    return isDeepEqual(a, b, depth);
}

export function isDeepEqual(a: any, b: any, depth = Number.POSITIVE_INFINITY, stack?: Array<[any, any]>): boolean {
    if (depth <= 0) {
        return a === b;
    } else if (a === b) {
        return true;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        // First check if we are already comparing these objects in the stack
        if (stack) {
            for (const [x, y] of stack) {
                if (x === a && y === b) {
                    return true;
                }
            }
        }
        const arrA = isArray(a);
        const arrB = isArray(b);

        if (arrA && arrB) {
            const length = a.length;
            if (length !== b.length) {
                return false;
            }
            for (let i = length; i-- !== 0;) {
                if (!isDeepEqual(a[i], b[i], depth - 1, stack)) {
                    return false;
                }
            }
            return true;
        }

        if (arrA !== arrB) {
            return false;
        }
        const dateA = a instanceof Date;
        const dateB = b instanceof Date;
        if (dateA !== dateB) {
            return false;
        }
        if (dateA && dateB) {
            return a.getTime() === b.getTime();
        }

        const regexpA = a instanceof RegExp;
        const regexpB = b instanceof RegExp;
        if (regexpA !== regexpB) {
            return false;
        }
        if (regexpA && regexpB) {
            return a.toString() === b.toString();
        }
        const keyList = keys(a);
        const keyCount = keyList.length;

        if (keyCount !== keys(b).length) {
            return false;
        }
        for (let i = keyCount; i-- !== 0;) {
            if (!hasOwnProperty(b, keyList[i])) {
                return false;
            }
        }
        for (let i = keyCount; i-- !== 0;) {
            const key = keyList[i];
            stack = stack || [];
            stack.push([a, b]);
            if (!isDeepEqual(a[key], b[key], depth - 1, stack)) {
                return false;
            }
            stack.pop();
        }
        return true;
    }
    return a !== a && b !== b;
}

/**
 * Compares the given values and return 1, -1 or 0 depending on
 * whether the first value is larger, smaller or equal to the second.
 * @param a First value
 * @param b Second value
 * @param direction Which order is used, 'asc' or 'desc'
 */
export function compare<T>(a: T, b: T, direction: 'asc' | 'desc' = 'asc') {
    const factor = direction === 'desc' ? -1 : 1;
    if (a > b) {
        return factor;
    }
    if (a < b) {
        return -factor;
    }
    return 0;
}

/**
 * Check that the given object has every matching property in the second object,
 * returning true/false accordingly. The first object may contain additional properties.
 * This is useful for simple filtering.
 *
 * @param obj Object whose properties are checked
 * @param values The required values
 */
export function hasProperties(obj: {[key: string]: any}, values: {[key: string]: any}): boolean {
    return keys(values).every((key) => {
        const value = values[key];
        return typeof value === 'undefined' || isEqual(values[key], obj[key]);
    });
}

export function isNully(value: any): value is null | undefined {
    return value == null;
}

export function isNotNully<T>(value: T): value is Exclude<T, null | undefined> {
    return value != null;
}
