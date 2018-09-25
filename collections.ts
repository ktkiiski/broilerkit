import { filterAsync, mapAsync, mergeSortedAsync, toAsync } from './async';
import { shareIterator } from './iteration';
import { isEqual } from './utils/compare';
import { pick, spread } from './utils/objects';

export interface ResourceAddition<T, K extends keyof T> {
    type: 'addition';
    collectionUrl: string;
    resourceIdentity: Pick<T, K>;
    resource: T;
}

export interface ResourceUpdate<T, K extends keyof T> {
    type: 'update';
    collectionUrl?: string;
    resourceUrl: string;
    resourceIdentity: Pick<T, K>;
    resource: Partial<T>;
}

export interface ResourceRemoval<T, K extends keyof T> {
    type: 'removal';
    collectionUrl?: string;
    resourceUrl: string;
    resourceIdentity: Pick<T, K>;
}

export type ResourceChange<T, K extends keyof T> = ResourceAddition<T, K> | ResourceUpdate<T, K> | ResourceRemoval<T, K>;

export function applyCollectionChange<T, K extends keyof T, S extends keyof T>(collection: AsyncIterable<T>, change: ResourceChange<T, K>, idAttributes: K[], ordering: S, direction: 'asc' | 'desc'): AsyncIterable<T> {
    const resourceIdentity = change.resourceIdentity;
    if (change.type === 'removal') {
        // Filter out any matching resource from the collection
        return shareIterator(filterAsync(collection, (item) => {
            const itemIdentity = pick(item, idAttributes);
            return !isEqual(itemIdentity, resourceIdentity);
        }));
    } else if (change.type === 'addition') {
        // Add a new resource to the corresponding position, according to the ordering
        return shareIterator(
            mergeSortedAsync(
                [
                    toAsync([change.resource]),
                    // Ensure that the item won't show up from the original collection
                    filterAsync(collection, (item) => (
                        !isEqual(pick(item, idAttributes), resourceIdentity)
                    )),
                ],
                ordering, direction,
            ),
        );
    } else {
        // Apply the changes to an item whose ID matches
        return shareIterator(mapAsync(collection, (item): T => {
            const itemIdentity = pick(item, idAttributes);
            if (isEqual(itemIdentity, resourceIdentity)) {
                return spread(item, change.resource);
            }
            return item;
        }));
    }
}
