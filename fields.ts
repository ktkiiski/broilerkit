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
        return String(value);
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
