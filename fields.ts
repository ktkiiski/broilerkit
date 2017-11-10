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
        if (typeof value === 'string' || (typeof value === 'number' && isFinite(value))) {
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
        }
        // Try to parse from a string to an integer
        if (typeof value === 'string') {
            value = parseInt(value, 10);
        }
        if (typeof value === 'number' && isFinite(value)) {
            return Math.floor(value);
        }
        throw new ValidationError(`Invalid integer value`);
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
        if (typeof value === 'boolean') {
            return value;
        }
        throw new ValidationError(`Invalid boolean value`);
    }
    public output(value: boolean): boolean {
        return value;
    }
}

class DateTimeField implements Field<string, Date> {
    public input(value: any): Date {
        if (typeof value === 'string') {
            // Try to parse the date from the string
            value = Date.parse(value);
        }
        if (typeof value !== 'number') {
            throw new ValidationError(`Invalid string or integer type`);
        }
        if (isFinite(value)) {
            // Accept the number of milliseconds from epoch
            return new Date(value);
        }
        throw new ValidationError(`Invalid date/time format`);
    }
    public output(value: Date): string {
        return value.toISOString();
    }
}

class RegexpField extends StringField {
    constructor(
        private readonly regexp: RegExp,
        private readonly errorMessage = `String not matching regular expression ${regexp}`) {
        super();
    }
    public input(value: any): string {
        const strValue = super.input(value);
        if (this.regexp.test(strValue)) {
            return strValue;
        }
        throw new ValidationError(this.errorMessage);
    }
}

class UUIDField extends RegexpField {
    constructor(version?: 1 | 4 | 5) {
        super(
            new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-[${version || '145'}][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'i'),
            version ? `Value is not a valid UUID` : `Value is not a valid UUID version ${version}`,
        );
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

export function datetime(): Field<string, Date> {
    return new DateTimeField();
}

export function uuid(version?: 1 | 4 | 5): Field<string, string> {
    return new UUIDField(version);
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
