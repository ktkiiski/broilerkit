import { keys } from './objects';

const isArray = Array.isArray;
const hasProp = Object.prototype.hasOwnProperty;

/**
 * Compares the two given values with deep comparison
 * and returns whether or not they are equal.
 *
 * @param a First value to compare
 * @param b Second value to compare
 */
export function isEqual(a: any, b: any): boolean {
    if (a === b) {
        return true;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const arrA = isArray(a);
        const arrB = isArray(b);

        if (arrA && arrB) {
            const length = a.length;
            if (length !== b.length) {
                return false;
            }
            for (let i = length; i-- !== 0;) {
                if (!isEqual(a[i], b[i])) {
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
            if (!hasProp.call(b, keyList[i])) {
                return false;
            }
        }
        for (let i = keyCount; i-- !== 0;) {
            const key = keyList[i];
            if (!isEqual(a[key], b[key])) {
                return false;
            }
        }
        return true;
    }
    return a !== a && b !== b;
}

export function hasAttributes(obj: {[key: string]: any}, values: {[key: string]: any}): boolean {
    for (const key in values) {
        if (!isEqual(values[key], obj[key])) {
            return false;
        }
    }
    return true;
}
