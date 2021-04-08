/* eslint-disable no-continue,@typescript-eslint/no-explicit-any */
import isEqual from 'immuton/isEqual';
import omit from 'immuton/omit';
import transform from 'immuton/transform';
import type { Key } from 'immuton/types';
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

export interface StateEffect {
    name: string;
    item: Serialization;
    exists: boolean;
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
    // TODO: Compress changes to the same resource instance
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

export function getStateEffects(
    effects: ResourceEffect[],
    operations: Operation<any, any, any>[],
    auth: UserSession | null,
): StateEffect[] {
    const states: Map<string, { item: Properties; resource: Resource<any, any, any> }> = new Map();
    const removals: Map<string, { item: Properties; resource: Resource<any, any, any> }> = new Map();
    for (const effect of compressEffects(effects)) {
        const { newState, oldState } = effect;
        if (newState && isEqual(newState, oldState)) {
            // No actual changes -> skip
            continue;
        }
        const { name } = effect.resource;
        const item = newState || oldState;
        const exists = !!newState;
        for (const operation of operations) {
            const { resource } = operation.endpoint;
            for (const [result, resultExists] of applyResourceStateToBase(resource, name, item, exists)) {
                // Check that the user has the permission to see this change
                try {
                    authorize(operation, auth, result);
                } catch {
                    // User is not authorized to this endpoint, with this resource instance
                    continue;
                }
                let id: string;
                try {
                    id = resource.getUniqueId(result);
                } catch {
                    // Item may not have identity properties
                    continue;
                }
                if (resultExists) {
                    const stateEffect = states.get(id);
                    states.set(id, {
                        resource,
                        item: {
                            ...stateEffect?.item,
                            ...result,
                        },
                    });
                } else {
                    removals.set(id, { resource, item: result });
                }
            }
        }
    }
    const stateEffects: StateEffect[] = [];
    for (const { item, resource } of states.values()) {
        const serializer = resource.optional({
            required: resource.identifyBy,
            optional: keys(omit(resource.fields, resource.identifyBy)),
            defaults: {},
        });
        try {
            stateEffects.push({
                exists: true,
                name: resource.name,
                item: serializer.serialize(item),
            });
        } catch {
            // Item did not have all the required properties
        }
    }
    for (const { item, resource } of removals.values()) {
        try {
            stateEffects.push({
                exists: false,
                name: resource.name,
                item: resource.identifier.serialize(item),
            });
        } catch {
            // Item did not have all the required properties
        }
    }
    return stateEffects;
}

type Properties = { [key: string]: unknown };

function* applyResourceStateToBase(
    baseResource: Resource<any, any, any>,
    resourceName: string,
    item: Properties,
    exists: boolean,
): Iterable<[Properties, boolean]> {
    if (baseResource.name === resourceName) {
        const nonRelationResource = baseResource.omit(keys(baseResource.nestings)).fullPartial();
        try {
            yield [nonRelationResource.validate(item), exists];
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`Failed to validate resource ${resourceName} state`, error);
        }
    }
    for (const join of baseResource.joins) {
        for (const [subResult] of applyResourceStateToBase(join.resource, resourceName, item, exists)) {
            const result = transformJoin(join, subResult);
            if (result != null) {
                if (exists || join.type === 'inner') {
                    yield [result, exists];
                } else if (join.type === 'left') {
                    yield [{ ...result, ...join.defaults }, true];
                }
            }
        }
    }
    for (const nestingName of keys(baseResource.nestings)) {
        const nesting = baseResource.nestings[nestingName];
        if (nesting.resource.name === resourceName) {
            // The nested resource must have all the properties
            let subResult;
            try {
                subResult = nesting.resource.validate(item);
            } catch {
                // Partial (or invalid) nested item
                continue;
            }
            const result = {
                [nestingName]: exists ? subResult : null,
            };
            for (const sourceProp of keys(nesting.on)) {
                const targetProp = nesting.on[sourceProp];
                result[targetProp] = subResult[sourceProp];
            }
            yield [result, true];
        }
    }
}

function transformJoin(join: Join, item: Properties) {
    const result = transform(join.fields, (sourceProp) => item[sourceProp]);
    for (const sourceProp of keys(join.on)) {
        const targetProp = join.on[sourceProp];
        const value = item[sourceProp];
        if (typeof targetProp === 'string') {
            result[targetProp] = value;
        } else if (!isEqual(targetProp.value, value)) {
            return null;
        }
    }
    return result;
}
