export interface OrderedQuery<T, K extends keyof T> {
    ordering: K;
    direction: 'asc' | 'desc';
    since?: T[K] | undefined;
}

export interface SlicedQuery<T, K extends keyof T> extends OrderedQuery<T, K> {
    minCount: number;
    maxCount: number;
}

export interface HashIndexQuery<T, P extends keyof T, S extends keyof T> extends SlicedQuery<T, S> {
    key: P;
    value: T[P];
}

export interface Model<T, PK extends keyof T, V extends keyof T, D> {
    table: Table<Model<T, PK, V, D>>;
    /**
     * Gets the item from the database using the given identity
     * object, containing all the identifying attributes.
     *
     * It results to an error if the item is not found.
     * Optionally the error object may be given as an attribute.
     *
     * Results to the item object, with all of its attributes,
     * if found successfully.
     */
    retrieve(identity: Pick<T, PK>, notFoundError?: Error): Promise<T>;
    /**
     * Inserts an item with the given ID to the database,
     * The given item must contain all model attributes, including
     * the identifying attributes and the version attribute.
     *
     * It results to an error if an item with the same identifying
     * attributes already exists in the database.
     *
     * Results to the given item object if inserted successfully.
     */
    create(item: T, alreadyExistsError?: Error): Promise<T>;
    /**
     * Updates an existing item in the database, identified by the given
     * identity object. The given item object must contain all model attributes,
     * including the identifying attributes and the new version attribute.
     *
     * NOTE: It is an error to attempt changing identifying attributes!
     *
     * The identity may optionally include the version attribute.
     * In this case, the update is done only if the existing item's version
     * matches the version in the identity object. This allows making
     * non-conflicting updates.
     *
     * It results to an error if an item does not exist. Also fails if the
     * existing item's version does not match any given version.
     *
     * Results to the updated item object if inserted successfully.
     */
    put(identity: Pick<T, PK> | Pick<T, V | PK>, item: T, notFoundError?: Error): Promise<T>;
    /**
     * Updates some of the attributes of an existing item in the database,
     * identified by the given identity object. The changes must contain
     * the version attribute, and any sub-set of the other attributes.
     *
     * NOTE: It is an error to attempt changing identifying attributes!
     *
     * The identity may optionally include the version attribute.
     * In this case, the update is done only if the existing item's version
     * matches the version in the identity object. This allows making
     * non-conflicting updates.
     *
     * Fails if the item does not exist. Also fails if the
     * existing item's version does not match any given version.
     *
     * Results to the updated item object with all up-to-date attributes,
     * if updated successfully.
     */
    patch(identity: Pick<T, PK> | Pick<T, V | PK>, changes: Partial<T> & Pick<T, V>, notFoundError?: Error): Promise<T>;
    /**
     * Same than patch, but instead resulting to the whole updated object,
     * only results to the changes given as parameter. Prefer this instead
     * of patch if you do not need to know all the up-to-date attributes of the
     * object after a successful patch, as this is more efficient.
     */
    patchUp<C extends Partial<T> & Pick<T, V>>(identity: Pick<T, PK> | Pick<T, V | PK>, changes: C, notFoundError?: Error): Promise<C>;
    /**
     * Either creates an item or replaces an existing one.
     * Use this instead of create/put method if you don't care if the
     * item already existed in the database.
     *
     * Results to the given item object if written successfully.
     */
    write(item: T): Promise<T>;
    /**
     * Deletes an item from the database, identified by the given
     * identity object. Fails if the item does not exists.
     */
    destroy(identity: Pick<T, PK>, notFoundError?: Error): Promise<void>;
    /**
     * Deletes an item from the database if it exists in the database.
     * Unlike destroy, this does not fail if the item didn't exists.
     */
    clear(identity: Pick<T, PK>): Promise<void>;
    /**
     * Queries and finds the first items from the table.
     * Always returns at least `minCount` number of items, unless there are no
     * more matching items to follow. It never returns more than `maxCount` items.
     *
     * You can determine whether the end-of-query is reached by checking if the
     * actual number of returned items is less than `minCount`.
     */
    list(query: D): Promise<T[]>;
    // TODO: query(query: D): Observable<T>;
}

export interface Table<M> {
    name: string;
    getModel(region: string, tableId: string): M;
}
