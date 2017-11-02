import isBoolean = require('lodash/isBoolean');
import isFinite = require('lodash/isFinite');
import isString = require('lodash/isString');
import { Moment } from 'moment';
import * as moment from 'moment';

export interface Field<E, I> {
    input(value: E): I;
    output(value: I): E;
}

export class ValidationError extends Error {
    public readonly invalid = true;
}

class ChoiceField<K> implements Field<K, K> {
    constructor(private options: K[]) {}
    public input(value: any): K {
        if (this.options.indexOf(value) >= 0) {
            return value;
        }
        throw new ValidationError(`Value is not one of the valid options`);
    }
    public output(value: K): K {
        return value;
    }
}

class StringField implements Field<string, string> {
    public input(value: any): string {
        if (value == null) {
            throw new ValidationError(`Missing string value`);
        }
        if (isString(value) || isFinite(value)) {
            return String(value);
        }
        throw new ValidationError(`Invalid string value`);
    }
    public output(value: string): string {
        return value;
    }
}

class IntegerField implements Field<number, number> {
    public input(value: any): number {
        if (value == null) {
            throw new ValidationError(`Missing integer value`);
        } else if (isFinite(value)) {
            return Math.floor(value);
        } else if (isString(value)) {
            return parseInt(value, 10);
        } else {
            throw new ValidationError(`Invalid integer value`);
        }
    }
    public output(value: number): number {
        return value;
    }
}

class BooleanField implements Field<boolean, boolean> {
    public input(value: any): boolean {
        if (value == null) {
            throw new ValidationError(`Missing boolean value`);
        }
        if (isBoolean(value)) {
            return value;
        }
        throw new ValidationError(`Invalid boolean value`);
    }
    public output(value: boolean): boolean {
        return value;
    }
}

class DateTimeField implements Field<string, Moment> {
    public input(value: any): Moment {
        if (isString(value) || isFinite(value)) {
            const internalValue = moment(value);
            if (internalValue.isValid()) {
                return internalValue;
            }
            throw new ValidationError(`Invalid date/time format`);
        }
        throw new ValidationError(`Invalid string or integer type`);
    }
    public output(value: Moment): string {
        return value.toISOString();
    }
}

/**
 * Wraps another field allowing its values to be undefined.
 */
class OptionalField<E, I> implements Field<E | undefined, I> {
    constructor(public readonly field: Field<E, I>) {}
    public input(value: any): I {
        return value === undefined ? value : this.field.input(value);
    }
    public output(value: I): E {
        return this.field.output(value);
    }
}

/**
 * Wraps another field allowing its values to be null.
 */
class NullableField<E, I> implements Field<E | null, I> {
    constructor(public readonly field: Field<E, I>) {}
    public input(value: any): I {
        return value === null ? value : this.field.input(value);
    }
    public output(value: I): E {
        return this.field.output(value);
    }
}

/**
 * Wraps another field allowing its inputs to be undefined, but
 * in those cases returns the given default value.
 */
class DefaultValueField<E, I> implements Field<E | undefined, I> {
    constructor(public readonly field: Field<E, I>, public readonly defaultValue: I) {}
    public input(value: any): I {
        return value === undefined ? this.defaultValue : this.field.input(value);
    }
    public output(value: I): E {
        return this.field.output(value);
    }
}

export function string(): Field<string, string> {
    return new StringField();
}

export function choice<K extends string>(options: K[]): Field<K, K> {
    return new ChoiceField<K>(options);
}

export function integer(): Field<number, number> {
    return new IntegerField();
}

export function boolean(): Field<boolean, boolean> {
    return new BooleanField();
}

export function datetime(): Field<string, Moment> {
    return new DateTimeField();
}

export function optional<E, I>(field: Field<E, I>): Field<E | undefined, I | undefined> {
    return new OptionalField(field);
}

export function nullable<E, I>(field: Field<E, I>): Field<E | null, I | null> {
    return new NullableField(field);
}

export function withDefault<E, I>(field: Field<E, I>, defaultValue: I): Field<E | undefined, I> {
    return new DefaultValueField(field, defaultValue);
}
