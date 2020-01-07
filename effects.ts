import { Operation } from './operations';
import { authorize } from './permissions';
import { Resource } from './resources';
import { UserSession } from './sessions';
import { buildQuery } from './url';
import { getObjectChanges, Key, keys, pick } from './utils/objects';

export interface ResourceEffect<T = any, PK extends Key<T> = any> {
    resource: Resource<T, PK, any>;
    identity: Pick<T, PK>;
    newState: T | null;
    oldState: T | null;
}

export interface EffectContext {
    readonly effects: ResourceEffect[];
}

export function addEffect<T, PK extends Key<T>>(context: EffectContext, resource: Resource<T, PK, any>, newState: T | null, oldState: T | null): void {
    const state = newState || oldState;
    if (!state) {
        return;
    }
    const identity = resource.identifier.validate(state);
    // TODO: Compress changes to the same resource instance
    context.effects.push({ resource, identity, newState, oldState });
}

export function getEffectHeaders(effects: ResourceEffect[], operations: Array<Operation<any, any, any>>, auth: UserSession | null): string[] {
    const headers: string[] = [];
    for (const effect of effects) {
        const { name, identifyBy } = effect.resource;
        const newState = encodeResourceState(name, effect.newState, operations, auth);
        const oldState = encodeResourceState(name, effect.oldState, operations, auth);
        if (newState && oldState) {
            // Resource is and was "visible" for the user
            // Only send the difference (and identifying keys)
            const stateDiff = {
                ...getObjectChanges(oldState, newState, 0),
                ...pick(newState, identifyBy),
            };
            headers.push(`${name}?${buildQuery(stateDiff)}`);
        } else if (newState) {
            // Resource become "visible" for the user
            headers.push(`${name}?${buildQuery(newState)}`);
        } else if (oldState) {
            // Resource is no longer visible for the user
            headers.push(`-${name}?${buildQuery(oldState)}`);
        }
    }
    return headers;
}

function encodeResourceState<T>(resourceName: string, item: T | null, operations: Array<Operation<any, any, any>>, auth: UserSession | null) {
    if (!item) {
        return null;
    }
    let newState: {[key: string]: string} | null = null;
    for (const operation of operations) {
        const { resource } = operation.endpoint;
        if (resource.name !== resourceName) {
            // This endpoint is not for this resource type
            continue;
        }
        if (resource.joins.length) {
            // TODO: Support joined resources!
            continue;
        }
        try {
            authorize(operation, auth, item);
        } catch {
            // User is not authorized to this endpoint, with this resource instance
            continue;
        }
        const nonRelationResource = resource.omit(keys(resource.nestings));
        try {
            newState = { ...newState || {}, ...nonRelationResource.encode(item) };
        } catch (error) {
            // tslint:disable-next-line:no-console
            console.error(`Failed to validate effect state for resource ${resourceName}`, error);
            continue;
        }
    }
    return newState;
}
