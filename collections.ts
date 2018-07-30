import { filterAsync, mapAsync, mergeSortedAsync, toAsync } from './async';
import { shareIterator } from './iteration';
import { isEqual } from './utils/compare';
import { spread } from './utils/objects';

export interface ResourceAddition<T, K extends keyof T> {
    type: 'addition';
    collectionUrl: string;
    resourceId: T[K];
    resource: T;
}

export interface ResourceUpdate<T, K extends keyof T> {
    type: 'update';
    resourceUrl: string;
    resourceId: T[K];
    resource: Partial<T>;
}

export interface ResourceRemoval<T, K extends keyof T> {
    type: 'removal';
    resourceUrl: string;
    resourceId: T[K];
}

export type ResourceChange<T, K extends keyof T> = ResourceAddition<T, K> | ResourceUpdate<T, K> | ResourceRemoval<T, K>;

export function applyCollectionChange<T, K extends keyof T, S extends keyof T>(collection: AsyncIterable<T>, change: ResourceChange<T, K>, idAttribute: K, ordering: S, direction: 'asc' | 'desc'): AsyncIterable<T> {
    const resourceId: T[K] = change.resourceId;
    if (change.type === 'removal') {
        // Filter out any matching resource from the collection
        return shareIterator(filterAsync(collection, (item) => {
            const itemId: T[K] = item[idAttribute];
            return !isEqual(itemId, resourceId);
        }));
    } else if (change.type === 'addition') {
        // Add a new resource to the corresponding position, according to the ordering
        return shareIterator(
            mergeSortedAsync(
                [
                    toAsync([change.resource]),
                    // Ensure that the item won't show up from the original collection
                    filterAsync(collection, (item) => !isEqual(item[idAttribute], resourceId)),
                ],
                ordering, direction,
            ),
        );
    } else {
        // Apply the changes to an item whose ID matches
        return shareIterator(mapAsync(collection, (item): T => {
            const itemId: T[K] = item[idAttribute];
            if (isEqual(itemId, resourceId)) {
                return spread(item, change.resource);
            }
            return item;
        }));
    }
}

export function isCollectionChange(collectionUrl: string, change: ResourceChange<any, any>): boolean {
    if (change.type === 'addition') {
        return change.collectionUrl === collectionUrl;
    }
    const resourceUrl = change.resourceUrl;
    return resourceUrl.replace(/\/[^/]+\/?$/, '') === collectionUrl;
}
