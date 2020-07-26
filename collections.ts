import hasProperties from 'immuton/hasProperties';
import { filterAsync, mapAsync, mergeSortedAsync, toAsync } from './async';
import { shareIterator } from './iteration';

export interface ResourceAddition<T, K extends keyof T> {
    type: 'addition';
    resourceName: string;
    resourceIdentity: Pick<T, K>;
    resource: T;
}

export interface ResourceUpdate<T, K extends keyof T> {
    type: 'update';
    resourceName: string;
    resourceIdentity: Pick<T, K>;
    resource: Partial<T>;
}

export interface ResourceRemoval<T, K extends keyof T> {
    type: 'removal';
    resourceName: string;
    resourceIdentity: Pick<T, K>;
}

export type ResourceChange<T, K extends keyof T> =
    | ResourceAddition<T, K>
    | ResourceUpdate<T, K>
    | ResourceRemoval<T, K>;

export function applyCollectionChange<T, K extends keyof T, S extends keyof T>(
    collection: AsyncIterable<T>,
    change: ResourceChange<T, K>,
    ordering: S,
    direction: 'asc' | 'desc',
): AsyncIterable<T> {
    const { resourceIdentity } = change;
    if (change.type === 'removal') {
        // Filter out any matching resource from the collection
        return shareIterator(filterAsync(collection, (item) => !hasProperties(item, resourceIdentity)));
    }
    if (change.type === 'addition') {
        // Add a new resource to the corresponding position, according to the ordering
        return shareIterator(
            mergeSortedAsync(
                [
                    toAsync([change.resource]),
                    // Ensure that the item won't show up from the original collection
                    filterAsync(collection, (item) => !hasProperties(item, resourceIdentity)),
                ],
                ordering,
                direction,
            ),
        );
    }
    // Apply the changes to an item whose ID matches
    return shareIterator(
        mapAsync(
            collection,
            (item): T => {
                if (hasProperties(item, resourceIdentity)) {
                    return { ...item, ...change.resource };
                }
                return item;
            },
        ),
    );
}
