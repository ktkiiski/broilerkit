import { ValidationError } from './errors';

const dateRegexp = /^(\d{4})-(\d{2})-(\d{2})$/;

export function serializeDateTime(value: Date): string {
    return value.toISOString();
}
export function deserializeDateTime(value: unknown): Date {
    if (typeof value === 'string') {
        // Try to parse the date from the string
        // eslint-disable-next-line no-param-reassign
        value = Date.parse(value);
    }
    if (typeof value !== 'number') {
        throw new ValidationError(`Invalid string or integer type`);
    }
    if (Number.isFinite(value)) {
        // Accept the number of milliseconds from epoch
        return new Date(value);
    }
    throw new ValidationError(`Invalid date/time format`);
}
export function serializeDate(value: Date): string {
    return value.toISOString().slice(0, 'YYYY-MM-DD'.length);
}
export function deserializeDate(value: unknown): Date {
    if (typeof value !== 'string') {
        throw new ValidationError(`Date must be a string`);
    }
    // Try to parse the date from the string
    const match = dateRegexp.exec(value);
    if (!match) {
        throw new ValidationError(`Invalid date format`);
    }
    const [, yearStr, monthStr, dateStr] = match;
    return new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, parseInt(dateStr, 10));
}
