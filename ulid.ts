import * as ULID from 'ulid';

const ulidFactory = ULID.monotonicFactory();

/**
 * Generates a new ULID identifier string and returns it.
 * The identifier is guaranteed to be higher than returned
 * by the previous call.
 *
 * By default the current time is used as a seed, but you
 * can optionally provide a timestamp which will be used.
 *
 * @param timestamp Optional time seed, either integer or Date
 */
export function ulid(timestamp?: number | Date): string {
    return ulidFactory(timestamp && +timestamp);
}

export function decodeTime(id: string): number {
    return ULID.decodeTime(id);
}

export function decodeDate(id: string): Date {
    return new Date(decodeTime(id));
}
