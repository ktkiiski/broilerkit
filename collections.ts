import filter = require('lodash/filter');
import orderBy = require('lodash/orderBy');

/**
 * Sorts the given array of values by a key attribute using the
 * given direction. Optionally also filters only values whose
 * attribute values are "before" or "after" of the given 'since' value
 * depending on the direction.
 */
export function order<T, K extends keyof T>(values: T[], ordering: K, direction: 'asc' | 'desc', since?: T[K]): T[] {
    if (since == null) {
        // No need to slice, just sort
        return orderBy(values, ordering, direction);
    }
    const filterer = direction === 'asc'
        ? (value: T) => value[ordering] > since
        : (value: T) => value[ordering] < since
    ;
    return orderBy(filter(values, filterer), ordering, direction);
}
