import * as ulid from './ulid';

/**
 * Generates a new ID that you can assume to
 * - be unique
 * - be lexically larger than any previous ID
 * - contain random portion
 *
 * @param timestamp Optional time seed, either integer or Date
 */
export function identifier(timestamp?: number | Date): string {
    return ulid.ulid(timestamp).slice(1).toLowerCase();
}

export function decodeTime(id: string): number {
    return ulid.decodeTime(`0${id.toUpperCase()}`);
}

export function decodeDate(id: string): Date {
    return new Date(decodeTime(id));
}
