import hasOwnProperty from 'immuton/hasOwnProperty';
import objectDifference from 'immuton/objectDifference';
import propertyless from 'immuton/propertyless';
import type { Key, Require } from 'immuton/types';
import { ValidationError } from './errors';
import type { Resource } from './resources';
import type { Serialization } from './serializers';

interface ResourceChangeBase<T, K extends keyof T> {
    name: string;
    identity: Pick<T, K>;
}

export interface ResourceAddition<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'addition';
    properties: Omit<T, K>;
}

export interface ResourceReplace<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'replace';
    oldProperties: Omit<T, K>;
    updates: Partial<Omit<T, K>>;
}

export interface ResourceUpdate<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'update';
    updates: Partial<Omit<T, K>>;
}

export interface ResourceRemoval<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'removal';
    properties: Omit<T, K>;
}

export interface ResourceDeletion<T, K extends keyof T> extends ResourceChangeBase<T, K> {
    type: 'deletion';
}

export type ResourceChange<T, PK extends keyof T> =
    | ResourceAddition<T, PK>
    | ResourceReplace<T, PK>
    | ResourceUpdate<T, PK>
    | ResourceRemoval<T, PK>
    | ResourceDeletion<T, PK>;

export type ExplicitResourceChange<T, PK extends keyof T> =
    | ResourceAddition<T, PK>
    | ResourceReplace<T, PK>
    | ResourceRemoval<T, PK>;

export function getOldState<T, PK extends keyof T>(change: ResourceUpdate<T, PK> | ResourceDeletion<T, PK>): undefined;
export function getOldState<T, PK extends keyof T>(change: ResourceAddition<T, PK>): null;
export function getOldState<T, PK extends keyof T>(change: ResourceRemoval<T, PK> | ResourceReplace<T, PK>): T;
export function getOldState<T, PK extends keyof T>(change: ResourceChange<T, PK>): T | null | undefined;
export function getOldState<T, PK extends keyof T>(change: ResourceChange<T, PK>): T | null | undefined {
    if (change.type === 'addition') {
        return null;
    }
    if (change.type === 'update' || change.type === 'deletion') {
        return undefined;
    }
    if (change.type === 'replace') {
        return { ...change.identity, ...change.oldProperties } as T;
    }
    return { ...change.identity, ...change.properties } as T;
}

export function getNewState<T, PK extends keyof T>(change: ResourceUpdate<T, PK>): undefined;
export function getNewState<T, PK extends keyof T>(change: ResourceRemoval<T, PK> | ResourceDeletion<T, PK>): null;
export function getNewState<T, PK extends keyof T>(change: ResourceReplace<T, PK> | ResourceAddition<T, PK>): T;
export function getNewState<T, PK extends keyof T>(change: ResourceChange<T, PK>): T | null | undefined;
export function getNewState<T, PK extends keyof T>(change: ResourceChange<T, PK>): T | null | undefined {
    if (change.type === 'removal' || change.type === 'deletion') {
        return null;
    }
    if (change.type === 'update') {
        return undefined;
    }
    if (change.type === 'replace') {
        return { ...change.identity, ...change.oldProperties, ...change.updates } as T;
    }
    return { ...change.identity, ...change.properties } as T;
}

export function getChangeProperties<T, PK extends keyof T>(change: ResourceUpdate<T, PK>): Require<T, PK>;
export function getChangeProperties<T, PK extends keyof T>(change: ResourceRemoval<T, PK>): null;
export function getChangeProperties<T, PK extends keyof T>(change: ResourceDeletion<T, PK>): null;
export function getChangeProperties<T, PK extends keyof T>(change: ResourceReplace<T, PK>): T;
export function getChangeProperties<T, PK extends keyof T>(change: ResourceAddition<T, PK>): T;
export function getChangeProperties<T, PK extends keyof T>(change: ResourceChange<T, PK>): Require<T, PK> | null;
export function getChangeProperties<T, PK extends keyof T>(change: ResourceChange<T, PK>): Require<T, PK> | null {
    if (change.type === 'update') {
        return { ...change.identity, ...change.updates } as Require<T, PK>;
    }
    return getNewState(change) as Require<T, PK> | null;
}

export function getChangeDelta<T, PK extends keyof T>(change: ResourceRemoval<T, PK> | ResourceDeletion<T, PK>): null;
export function getChangeDelta<T, PK extends keyof T>(change: ResourceAddition<T, PK>): T;
export function getChangeDelta<T, PK extends keyof T>(
    change: ResourceReplace<T, PK> | ResourceUpdate<T, PK>,
): Partial<T>;
export function getChangeDelta<T, PK extends keyof T>(change: ResourceChange<T, PK>): Partial<T> | null;
export function getChangeDelta<T, PK extends keyof T>(change: ResourceChange<T, PK>): Partial<T> | null {
    if (change.type === 'removal' || change.type === 'deletion') {
        return null;
    }
    if (change.type === 'addition') {
        return { ...change.identity, ...change.properties } as T;
    }
    return change.updates as Partial<T>;
}

export function makeAdditionChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    item: T,
): ResourceAddition<T, PK> {
    const { name, identifier, identifyBy } = resource;
    const propertySerializer = resource.omit(identifyBy);
    return {
        type: 'addition',
        name,
        identity: identifier.validate(item),
        properties: propertySerializer.validate(item),
    };
}

export function makeRemovalChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    item: T,
): ResourceRemoval<T, PK> {
    const { name, identifier, identifyBy } = resource;
    const propertySerializer = resource.omit(identifyBy);
    return {
        type: 'removal',
        name,
        identity: identifier.validate(item),
        properties: propertySerializer.validate(item),
    };
}

export function makeDeletionChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    identity: Pick<T, PK>,
): ResourceDeletion<T, PK> {
    const { name, identifier } = resource;
    return {
        type: 'deletion',
        name,
        identity: identifier.validate(identity),
    };
}

export function makeReplaceChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    oldState: T,
    newState: T,
): ResourceReplace<T, PK> | null {
    const { name, identifier, identifyBy } = resource;
    const propertySerializer = resource.omit(identifyBy);
    const stateDelta = objectDifference(oldState, newState);
    if (!Object.keys(stateDelta).length) {
        return null;
    }
    return {
        type: 'replace',
        name,
        identity: identifier.validate(newState),
        oldProperties: propertySerializer.validate(oldState),
        updates: propertySerializer.fullPartial().validate(stateDelta),
    };
}

export function makeUpdateChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    item: Require<T, PK>,
    oldItem: Partial<T> = propertyless,
): ResourceUpdate<T, PK> | null {
    const { name, identifier, identifyBy } = resource;
    const updateSerializer = resource.omit(identifyBy).fullPartial();
    const properties = updateSerializer.validate(item);
    const updates = objectDifference(oldItem, properties, Number.POSITIVE_INFINITY) as Partial<Omit<T, PK>>;
    if (!Object.keys(updates).length) {
        return null;
    }
    return {
        type: 'update',
        name,
        identity: identifier.validate(item),
        updates,
    };
}

export function determineChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    oldState: T,
    newState: null,
): ResourceRemoval<T, PK>;
export function determineChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    oldState: null,
    newState: T,
): ResourceAddition<T, PK>;
export function determineChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    oldState: null,
    newState: null,
): null;
export function determineChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    oldState: T | null,
    newState: T | null,
): ExplicitResourceChange<T, PK> | null;
export function determineChange<T, PK extends Key<T>, W extends Key<T>>(
    resource: Resource<T, PK, W>,
    oldState: T | null,
    newState: T | null,
): ExplicitResourceChange<T, PK> | null {
    if (!oldState) {
        if (!newState) {
            return null;
        }
        return makeAdditionChange(resource, newState);
    }
    if (!newState) {
        return makeRemovalChange(resource, oldState);
    }
    return makeReplaceChange(resource, oldState, newState);
}

export function deserializeResourceChange<T, PK extends Key<T>, W extends Key<T>>(
    change: unknown,
    resource: Resource<T, PK, W>,
): ResourceChange<T, PK> | null {
    const { identifier, identifyBy } = resource;
    const propertySerializer = resource.omit(identifyBy);
    if (!hasOwnProperty(change, 'type')) {
        throw new ValidationError(`Resource change is missing the "type" property`);
    }
    if (!hasOwnProperty(change, 'name')) {
        throw new ValidationError(`Resource change is missing the "name" property`);
    }
    const { type, name } = change;
    if (name !== resource.name) {
        return null;
    }
    const identity = identifier.deserialize(hasOwnProperty(change, 'identity') ? change.identity : {});
    if (type === 'deletion') {
        return { name, type, identity };
    }
    if (type === 'addition' || type === 'removal') {
        const properties = propertySerializer.deserialize(
            hasOwnProperty(change, 'properties') ? change.properties : {},
        );
        return { name, type, identity, properties };
    }
    const updates = propertySerializer
        .fullPartial()
        .deserialize(hasOwnProperty(change, 'updates') ? change.updates : {});
    if (type === 'update') {
        return { name, type, identity, updates };
    }
    if (type === 'replace') {
        const oldProperties = propertySerializer.deserialize(
            hasOwnProperty(change, 'oldProperties') ? change.oldProperties : {},
        );
        return { name, type, identity, updates, oldProperties };
    }
    throw new ValidationError(`Invalid change type ${JSON.stringify(name)}`);
}

export function serializeResourceChange<T, PK extends Key<T>, W extends Key<T>>(
    change: ResourceChange<T, PK>,
    resource: Resource<T, PK, W>,
): Serialization {
    const { identifier, identifyBy } = resource;
    const propertySerializer = resource.omit(identifyBy);
    const serialization: Serialization = {
        type: change.type,
        name: change.name,
    };
    if (hasOwnProperty(change, 'identity')) {
        serialization.identity = identifier.serialize(change.identity);
    }
    if (hasOwnProperty(change, 'properties')) {
        serialization.properties = propertySerializer.serialize(change.properties);
    }
    if (hasOwnProperty(change, 'oldProperties')) {
        serialization.properties = propertySerializer.serialize(change.oldProperties);
    }
    if (hasOwnProperty(change, 'updates')) {
        serialization.properties = propertySerializer.fullPartial().serialize(change.updates);
    }
    return serialization;
}
