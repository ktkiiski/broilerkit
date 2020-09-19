interface ResourceChangeBase<T, K extends keyof T> {
    name: string;
    identity: Pick<T, K>;
}

export interface ResourceAddition<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'addition';
    item: T;
}

export interface ResourceUpdate<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'update';
    item: Partial<T>;
}

export interface ResourceRemoval<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'removal';
}

export type ResourceChange<T, K extends keyof T> =
    | ResourceAddition<T, K>
    | ResourceUpdate<T, K>
    | ResourceRemoval<T, K>;
