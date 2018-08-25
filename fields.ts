import { ValidationError } from './http';
import { padEnd, padStart } from './utils/strings';

export type NonEmptyString = Exclude<string, ''>;

export interface Field<I, E = I> {
    validate(value: I): I;
    serialize(value: I): E;
    deserialize(value: any): I;
    encode(value: I): string;
    encodeSortable(value: I): string;
    decode(value: string): I;
}

class TextField implements Field<string> {
    public validate(value: string): string {
        return value;
    }
    public deserialize(value: any): string {
        if (value == null) {
            throw new ValidationError(`Missing string value`);
        }
        if (typeof value === 'string' || (typeof value === 'number' && isFinite(value))) {
            return this.validate(String(value));
        }
        throw new ValidationError(`Invalid string value`);
    }
    public serialize(value: string): string {
        return this.validate(value);
    }
    public encode(value: string): string {
        return this.validate(value);
    }
    public encodeSortable(value: string): string {
        return this.encode(value);
    }
    public decode(value: string): string {
        return this.validate(value);
    }
}

class TrimmedTextField extends TextField implements Field<NonEmptyString> {
    public validate(value: string): string {
        return super.validate(value).trim();
    }
}

class StringField extends TrimmedTextField {
    public validate(value: string): string {
        value = super.validate(value);
        if (!value) {
            throw new ValidationError(`Value may not be blank`);
        }
        return value;
    }
}

class ChoiceField<K extends string> extends TextField implements Field<K> {
    constructor(private options: K[]) {
        super();
    }
    public validate(value: string): K {
        const v = super.validate(value) as K;
        if (this.options.indexOf(v) >= 0) {
            return v;
        }
        throw new ValidationError(`Value is not one of the valid options`);
    }
    public serialize(value: K): K {
        return this.validate(value);
    }
    public deserialize(value: string): K {
        return this.validate(value);
    }
    public encode(value: K): K {
        return this.serialize(value);
    }
    public encodeSortable(value: K): K {
        return this.encode(value);
    }
    public decode(value: string): K {
        return this.deserialize(value);
    }
}

class NumberField implements Field<number> {
    public validate(value: number): number {
        if (isFinite(value)) {
            return value;
        }
        throw new ValidationError(`Invalid number value`);
    }
    public serialize(value: number): number {
        return this.validate(value);
    }
    public deserialize(value: any): number {
        if (value == null) {
            throw new ValidationError(`Missing number value`);
        }
        // Try to parse from a string to a number
        if (typeof value === 'string') {
            return this.decode(value);
        }
        if (typeof value === 'number') {
            return this.validate(value);
        }
        throw new ValidationError(`Invalid number value`);
    }
    public encode(value: number): string {
        return this.serialize(value).toString();
    }
    public encodeSortable(_: number): string {
        // TODO: Implement me!
        throw new Error(`Not implemented`);
    }
    public decode(value: string): number {
        return this.validate(parseFloat(value));
    }
}

const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const MIN_INTEGER = Number.MIN_SAFE_INTEGER;
const MAX_INTEGER_DIGITS = `${MAX_INTEGER}`.length;

class IntegerField implements Field<number> {
    public validate(value: number): number {
        if (isFinite(value)) {
            if (value > MAX_INTEGER) {
                throw new ValidationError(`Integer value cannot be greater than ${MAX_INTEGER}`);
            }
            if (value < MIN_INTEGER) {
                throw new ValidationError(`Integer value cannot be less than ${MIN_INTEGER}`);
            }
            return Math.floor(value);
        }
        throw new ValidationError(`Invalid integer value`);
    }
    public serialize(value: number): number {
        return this.validate(value);
    }
    public deserialize(value: any): number {
        if (value == null) {
            throw new ValidationError(`Missing integer value`);
        }
        // Try to parse from a string to an integer
        if (typeof value === 'string') {
            // If starting with special character '!', then it is a sortable encoding
            if (value[0] === '!') {
                value = parseInt(value.slice(1), 10) + MIN_INTEGER;
            } else {
                value = parseInt(value, 10);
            }
        }
        if (typeof value === 'number') {
            return this.validate(value);
        }
        throw new ValidationError(`Invalid integer value`);
    }
    public encode(value: number): string {
        return this.serialize(value).toFixed(0);
    }
    public encodeSortable(value: number): string {
        value = this.validate(value);
        let prefix = '+';
        if (value < 0) {
            value = value - MIN_INTEGER;
            prefix = '!';
        }
        const str = value.toFixed(0);
        const paddedStr = padStart(str, MAX_INTEGER_DIGITS, '0');
        return `${prefix}${paddedStr}`;
    }
    public decode(value: string): number {
        return this.deserialize(value);
    }
}

class ConstantField<K extends number> extends IntegerField {
    constructor(private options: K[]) {
        super();
    }
    public validate(value: number): K {
        const v = super.validate(value) as K;
        if (this.options.indexOf(v) >= 0) {
            return v;
        }
        throw new ValidationError(`Value is not one of the valid options`);
    }
    public serialize(value: K): K {
        return this.validate(value);
    }
    public deserialize(value: any): K {
        return super.deserialize(value) as K;
    }
    public encode(value: K): string {
        return super.encode(value);
    }
    public encodeSortable(value: K): string {
        return super.encodeSortable(value);
    }
    public decode(value: string): K {
        return this.deserialize(value);
    }
}

class BooleanField implements Field<boolean> {
    public validate(value: boolean): boolean {
        return value;
    }
    public deserialize(value: any): boolean {
        if (value === true || value === false) {
            return value;
        }
        throw new ValidationError(`Invalid boolean value`);
    }
    public serialize(value: boolean): boolean {
        return value;
    }
    public encode(value: boolean): 'true' | 'false' {
        return value ? 'true' : 'false';
    }
    public encodeSortable(value: boolean): 'true' | 'false' {
        return this.encode(value);
    }
    public decode(value: string): boolean {
        if (value === 'true') {
            return true;
        } else if (value === 'false') {
            return false;
        }
        throw new ValidationError(`Invalid encoded boolean value`);
    }
}

class DateTimeField implements Field<Date, string> {
    public validate(value: Date): Date {
        return value;
    }
    public serialize(value: Date): string {
        return value.toISOString();
    }
    public deserialize(value: any): Date {
        if (typeof value === 'string') {
            // Try to parse the date from the string
            value = Date.parse(value);
        }
        if (typeof value !== 'number') {
            throw new ValidationError(`Invalid string or integer type`);
        }
        if (isFinite(value)) {
            // Accept the number of milliseconds from epoch
            return this.validate(new Date(value));
        }
        throw new ValidationError(`Invalid date/time format`);
    }
    public encode(value: Date): string {
        return this.serialize(value);
    }
    public encodeSortable(value: Date): string {
        return this.serialize(value);
    }
    public decode(value: string): Date {
        return this.deserialize(value);
    }
}

class RegexpField extends TextField {
    constructor(
        private readonly regexp: RegExp,
        private readonly errorMessage = `String not matching regular expression ${regexp}`) {
        super();
    }
    public validate(value: string): string {
        const strValue = super.validate(value);
        if (this.regexp.test(strValue)) {
            return strValue;
        }
        throw new ValidationError(this.errorMessage);
    }
}

class DecimalField extends RegexpField {
    private numberField = new NumberField();
    constructor(private decimals: number) {
        super(
            /^[+-]?\d+(\.\d+)$/,
            `Value is not a valid decimal string`,
        );
    }
    public validate(value: string | number): string {
        const {decimals} = this;
        if (typeof value === 'number') {
            // Just convert the numeric value to a string
            return this.numberField.validate(value).toFixed(decimals);
        }
        value = super.validate(value);
        if (value[0] === '+') {
            value = value.slice(1);
        }
        const [numStr, decStr] = value.split('.');
        if (!decimals) {
            return numStr;
        }
        return numStr + '.' + padEnd((decStr || '').slice(0, decimals), decimals, '0');
    }
    public deserialize(value: any): string {
        if (typeof value === 'number') {
            return this.validate(value);
        }
        return super.deserialize(value);
    }
}

class EmailField extends RegexpField {
    constructor() {
        super(
            /^(([^<>()\[\]\.,;:\s@\"]+(\.[^<>()\[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i,
            `Value is not a valid email`,
        );
    }
}

class URLField extends RegexpField {
    constructor() {
        super(
            /^https?:\/\/[\w.-]+(?:\.[\w\.-]+)*[\w\-\._~:%/?#[\]@!\$&'\(\)\*\+,;=.]+$/i,
            `Value is not a valid URL`,
        );
    }
}

class UUIDField extends RegexpField {
    constructor(version?: 1 | 4 | 5) {
        super(
            new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-[${version || '145'}][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'i'),
            version ? `Value is not a valid UUID version ${version}` : `Value is not a valid UUID`,
        );
    }
}

class ULIDField extends RegexpField {
    constructor() {
        super(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/, `Value is not a valid ULID`);
    }
}

class IdField extends RegexpField {
    constructor() {
        super(/^[0123456789abcdefghjkmnpqrstvwxyz]{25}$/, `Value is not a valid ID`);
    }
}

function isNullable(value: any): value is null | '' {
    return value === null || value === '';
}

/**
 * Makes the given field nullable, allowing null values for it.
 * It also means that any blank value, e.g. an empty string, will
 * always be converted to null.
 *
 * Useful to be used with string(), datetime() and integer() fields.
 */
class NullableField<I, O extends string | number | boolean> implements Field<I | null, O | null> {
    constructor(public readonly field: Field<I, O>) {}
    public validate(value: I | null): I | null {
        return !isNullable(value) && this.field.validate(value) || null;
    }
    public serialize(value: I | null): O | null {
        return !isNullable(value) && this.field.serialize(value) || null;
    }
    public deserialize(value: any): I | null {
        return value === null || value === '' ? null : this.field.deserialize(value);
    }
    public encode(value: I | null): string {
        return !isNullable(value) && this.field.encode(value) || '';
    }
    public encodeSortable(value: I): string {
        return !isNullable(value) && this.field.encodeSortable(value) || '';
    }
    public decode(value: string): I | null {
        return !isNullable(value) && this.field.decode(value) || null;
    }
}

class ListField<I, O> implements Field<I[], O[]> {
    constructor(public readonly field: Field<I, O>) {}
    public validate(items: I[]): I[] {
        for (const item of items) {
            this.field.validate(item);
        }
        return items;
    }
    public serialize(items: I[]): O[] {
        return items.map((item) => this.field.serialize(item));
    }
    public deserialize(items: any): I[] {
        if (items && Array.isArray(items)) {
            return items.map((item) => this.field.deserialize(item));
        }
        throw new ValidationError(`Value is not an array`);
    }
    public encode(value: I[]): string {
        return value.map((item) => encodeURIComponent(this.field.encode(item))).join('&');
    }
    public encodeSortable(value: I[]): string {
        return value.map((item) => encodeURIComponent(this.field.encodeSortable(item))).join('&');
    }
    public decode(value: string): I[] {
        return value.split('&').map((item) => this.field.decode(decodeURIComponent(item)));
    }
}

export function string(): Field<NonEmptyString> {
    return new StringField();
}

export function trimmed(): Field<NonEmptyString> {
    return new TrimmedTextField();
}

export function text(): Field<string> {
    return new TextField();
}

export function choice<K extends string>(options: K[]): Field<K> {
    return new ChoiceField(options);
}

export function constant<K extends number>(options: K[]): Field<K> {
    return new ConstantField<K>(options);
}

export function integer(): Field<number> {
    return new IntegerField();
}

export function number(): Field<number> {
    return new NumberField();
}

export function decimal(decimals: number = 2): Field<string> {
    return new DecimalField(decimals);
}

export function boolean(): Field<boolean> {
    return new BooleanField();
}

export function datetime(): Field<Date, string> {
    return new DateTimeField();
}

export function uuid(version?: 1 | 4 | 5): Field<string> {
    return new UUIDField(version);
}

export function email(): Field<string> {
    return new EmailField();
}

export function ulid(): Field<string> {
    return new ULIDField();
}

export function id(): Field<string> {
    return new IdField();
}

export function url(): Field<string> {
    return new URLField();
}

export function nullable<I, O extends string | number | boolean>(field: Field<I, O>): Field<I | null, O | null> {
    return new NullableField(field);
}

export function list<I, O>(field: Field<I, O>): Field<I[], O[]> {
    return new ListField(field);
}
