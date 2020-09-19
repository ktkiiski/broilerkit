import hasProperties from 'immuton/hasProperties';
import { filterAsync, mapAsync, mergeSortedAsync, toAsync } from './async';
import type { ResourceChange } from './changes';
import { shareIterator } from './iteration';

export function applyCollectionChange<T, K extends keyof T, S extends keyof T>(
    collection: AsyncIterable<T>,
    change: ResourceChange<T, K>,
    ordering: S,
    direction: 'asc' | 'desc',
): AsyncIterable<T> {
    const { identity: resourceIdentity } = change;
    if (change.type === 'removal') {
        // Filter out any matching resource from the collection
        return shareIterator(filterAsync(collection, (item) => !hasProperties(item, resourceIdentity)));
    }
    if (change.type === 'addition') {
        // Add a new resource to the corresponding position, according to the ordering
        return shareIterator(
            mergeSortedAsync(
                [
                    toAsync([change.item]),
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
                    return { ...item, ...change.item };
                }
                return item;
            },
        ),
    );
}
