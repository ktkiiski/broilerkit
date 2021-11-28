/* eslint-disable no-continue,@typescript-eslint/no-explicit-any */
import isEqual from 'immuton/isEqual';
import omit from 'immuton/omit';
import transform from 'immuton/transform';
import type { Key, Require } from 'immuton/types';
import {
    ResourceChange,
    serializeResourceChange,
    makeAdditionChange,
    makeUpdateChange,
    makeDeletionChange,
    getChangeProperties,
    getOldState,
} from './changes';
import { keys } from './objects';
import type { Operation } from './operations';
import { authorize } from './permissions';
import type { Resource, Join } from './resources';
import type { Serialization } from './serializers';
import type { UserSession } from './sessions';

export interface ResourceEffect<T = any, PK extends Key<T> = any> {
    resource: Resource<T, PK, any>;
    identity: Pick<T, PK>;
    newState: T | null;
    oldState: T | null;
}

export interface EffectContext {
    readonly effects: ResourceEffect[];
}

export function addEffect<T, PK extends Key<T>>(
    context: EffectContext,
    resource: Resource<T, PK, any>,
    newState: T | null,
    oldState: T | null,
): void {
    const state = newState || oldState;
    if (!state) {
        return;
    }
    const identity = resource.identifier.validate(state);
    context.effects.push({ resource, identity, newState, oldState });
}

function compressEffects(inputEffects: ResourceEffect[]): ResourceEffect[] {
    return inputEffects.reduce<ResourceEffect[]>((effects, effect) => {
        // Is there already an effect for this item?
        const { name } = effect.resource;
        const index = effects.findIndex(
            (other) => other.resource.name === name && isEqual(other.identity, effect.identity),
        );
        if (index < 0) {
            effects.push(effect);
        } else {
            // Merge with existing state
            const other = effects[index];
            effects.splice(index, 1, {
                ...other,
                newState: effect.newState,
            });
        }
        return effects;
    }, []);
}

export function getSerializedStateEffectChanges(
    effects: ResourceEffect[],
    operations: Operation<any, any, any>[],
    auth: UserSession | null,
): Serialization[] {
    const changeSerializations: Serialization[] = [];
    for (const effect of compressEffects(effects)) {
        const { newState, oldState } = effect;
        if (newState && isEqual(newState, oldState)) {
            // No actual changes -> skip
            continue;
        }
        const { name } = effect.resource;
        for (const operation of operations) {
            const { resource } = operation.endpoint;
            for (const change of applyResourceStateToBase(resource, name, newState, oldState)) {
                const itemProperties = getChangeProperties(change);
                // Check that the user has the permission to see this change
                try {
                    authorize(operation, auth, itemProperties);
                } catch {
                    // User is not authorized to this endpoint, with this resource instance
                    continue;
                }
                const changeSerialization = serializeResourceChange(resource, change);
                changeSerializations.push(changeSerialization);
            }
        }
    }
    return changeSerializations;
}

type Properties = { [key: string]: unknown };

function* applyResourceStateToBase<T, PK extends Key<T>, W extends Key<T>>(
    baseResource: Resource<T, PK, W>,
    resourceName: string,
    newItem: Require<T, PK> | null,
    oldItem: Require<T, PK> | null,
): Iterable<ResourceChange<T, PK>> {
    if (baseResource.name === resourceName) {
        const nonRelationKeys = keys(baseResource.nestings) as Key<T>[];
        try {
            if (newItem && oldItem) {
                const change = makeUpdateChange(
                    baseResource,
                    omit(newItem, nonRelationKeys) as Require<T, PK>,
                    oldItem,
                );
                if (change) {
                    yield change;
                }
            } else if (newItem && !oldItem) {
                yield makeAdditionChange(baseResource, newItem as T);
            } else if (!newItem && oldItem) {
                yield makeDeletionChange(baseResource, oldItem);
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Failed to validate resource ${resourceName} state`, error);
        }
    }
    for (const join of baseResource.joins) {
        for (const subChange of applyResourceStateToBase(join.resource, resourceName, newItem, oldItem)) {
            const subItemNewProperties = getChangeProperties(subChange);
            const subItemOldProperties = getOldState(subChange);
            const subItemProperties = subItemNewProperties || subItemOldProperties;
            const exists = subItemNewProperties != null;
            const result = subItemProperties && transformJoin(join, subItemProperties);
            if (result != null) {
                let change;
                try {
                    if (exists || join.type === 'inner') {
                        change = makeUpdateChange(baseResource, result as Require<T, PK>);
                    } else if (join.type === 'left') {
                        // Left removed related item
                        change = makeUpdateChange(baseResource, { ...result, ...join.defaults } as Require<T, PK>);
                    }
                } catch {
                    // Likely missing identifying properties on joins
                    continue;
                }
                if (change) {
                    yield change;
                }
            }
        }
    }
    for (const nestingName of keys(baseResource.nestings)) {
        const nesting = baseResource.nestings[nestingName];
        if (nesting.resource.name === resourceName) {
            // The nested resource must have all the properties
            let newSubResult = null;
            if (newItem != null) {
                try {
                    newSubResult = nesting.resource.validate(newItem);
                } catch {
                    // Partial (or invalid) nested item
                    continue;
                }
            }
            let oldSubResult = null;
            if (oldItem != null) {
                try {
                    oldSubResult = nesting.resource.validate(oldItem);
                } catch {
                    // Partial (or invalid) nested item
                    continue;
                }
            }
            const newResult = { [nestingName]: newSubResult };
            const oldResult = { [nestingName]: oldSubResult };
            for (const sourceProp of keys(nesting.on)) {
                const targetProp = nesting.on[sourceProp];
                newResult[targetProp] = newSubResult[sourceProp];
                oldResult[targetProp] = oldSubResult[sourceProp];
            }
            yield [newResult, oldResult];
        }
    }
}

function transformJoin(join: Join, item: Properties): Properties | null {
    const result = transform(join.fields, (sourceProp) => item[sourceProp]);
    for (const sourcePropName of keys(join.on)) {
        const targetPropCond = join.on[sourcePropName];
        const value = item[sourcePropName];
        if (typeof targetPropCond === 'string') {
            result[targetPropCond] = value;
        } else if (!isEqual(targetPropCond.value, value)) {
            return null;
        }
    }
    return result;
}
