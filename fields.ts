import { decodeDataUri, DecodedDataUri, encodeDataUri } from './data-uri';
import { KeyErrorData, ValidationError } from './errors';
import { isApiResponse } from './http';
import { padEnd, padStart } from './strings';

export type NonEmptyString = Exclude<string, ''>;

export interface Field<I, E = I> {
    readonly type: string;
    validate(value: I): I;
    serialize(value: I): E;
    deserialize(value: unknown): I;
    encode(value: I): string;
    decode(value: string): I;
    encodeSortable(value: I): string;
    decodeSortable(value: string): I;
    pack(value: I): unknown;
    unpack(value: unknown): I;
}

abstract class BaseField<I, E = I> {
    public abstract validate(value: I): I;
    public abstract serialize(value: I): E;
    public abstract deserialize(value: unknown): I;
    public abstract encode(value: I): string;
    public abstract decode(value: string): I;
    public encodeSortable(value: I): string {
        return this.encode(value);
    }
    public decodeSortable(value: string): I {
        return this.decode(value);
    }
    public pack(value: I): unknown {
        return this.serialize(value);
    }
    public unpack(value: unknown): I {
        return this.deserialize(value);
    }
}

class TextField<S extends string = string> extends BaseField<S> implements Field<S> {
    public readonly type: string = 'text';
    public validate(value: string): S {
        return value as S;
    }
    public deserialize(value: unknown): S {
        if (value == null) {
            throw new ValidationError(`Missing string value`);
        }
        if (typeof value === 'string' || (typeof value === 'number' && isFinite(value))) {
            return this.validate(String(value));
        }
        throw new ValidationError(`Invalid string value`);
    }
    public serialize(value: S): S & string {
        return this.validate(value);
    }
    public encode(value: S): S {
        return this.validate(value);
    }
    public decode(value: S): S {
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

class ChoiceField<K extends string> extends TextField<K> implements Field<K> {
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
    public deserialize(value: string): K {
        return this.validate(value);
    }
}

interface NumberFieldOptions {
    min?: number;
    max?: number;
}

const POSITIVE_INFINITY = Number.POSITIVE_INFINITY;
const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;

class NumberField<N extends number = number> extends BaseField<N> implements Field<N> {
    public readonly type: string = 'double precision';
    constructor(private options: NumberFieldOptions) {
        super();
    }
    public validate(value: number): N {
        if (typeof value === 'number' && isFinite(value)) {
            const {min = NEGATIVE_INFINITY, max = POSITIVE_INFINITY} = this.options;
            if (value < min) {
                throw new ValidationError(`Value cannot be less than ${min}`);
            }
            if (value > max) {
                throw new ValidationError(`Value cannot be greater than ${max}`);
            }
            return value as N;
        }
        throw new ValidationError(`Invalid number value`);
    }
    public serialize(value: N): N {
        return this.validate(value) as N;
    }
    public deserialize(value: unknown): N {
        if (value == null) {
            throw new ValidationError(`Missing number value`);
        }
        // Try to parse from a string to a number
        if (typeof value === 'string') {
            return this.decode(value);
        }
        if (typeof value === 'number') {
            return this.validate(value as N);
        }
        throw new ValidationError(`Invalid number value`);
    }
    public encode(value: N): string {
        return this.serialize(value).toString();
    }
    public decode(value: string): N {
        return this.validate(parseFloat(value));
    }
    public encodeSortable(value: number): string {
        value = this.validate(value);
        const bytes = Array.from(new Uint16Array(Float64Array.from([Math.abs(value)]).buffer));
        const chunks = bytes.map((byte) => padStart((value < 0 ? 0xFFFF ^ byte : byte).toString(16), 4, '0')).reverse();
        return `${value < 0 ? '-' : '0'}${chunks.join('')}`;
    }
    public decodeSortable(value: string): N {
        const sign = value[0];
        const byteStr = value.slice(1);
        const byteArr: number[] = [];
        for (let i = 0; i < byteStr.length; i += 4) {
            const bytes = parseInt(byteStr.slice(i, i + 4), 16);
            if (isNaN(bytes)) {
                throw new ValidationError(`Invalid decoded number`);
            }
            byteArr.unshift(sign === '-' ? 0xFFFF ^ bytes : bytes);
        }
        const float = new Float64Array(Uint16Array.from(byteArr).buffer)[0];
        return this.validate(sign === '-' ? -float : float);
    }
}

const MAX_INTEGER = Math.min(Number.MAX_SAFE_INTEGER, +2147483647);
const MIN_INTEGER = Math.max(Number.MIN_SAFE_INTEGER, -2147483648);

class IntegerField<N extends number = number> extends NumberField<N> implements Field<N> {
    public readonly type: string = 'integer';
    public validate(value: number): N {
        if (typeof value === 'number' && isFinite(value)) {
            if (value > MAX_INTEGER) {
                throw new ValidationError(`Integer value cannot be greater than ${MAX_INTEGER}`);
            }
            if (value < MIN_INTEGER) {
                throw new ValidationError(`Integer value cannot be less than ${MIN_INTEGER}`);
            }
            return Math.trunc(super.validate(value)) as N;
        }
        throw new ValidationError(`Invalid integer value`);
    }
    public deserialize(value: unknown): N {
        if (value == null) {
            throw new ValidationError(`Missing integer value`);
        }
        // Try to parse from a string to an integer
        if (typeof value === 'string') {
            // If starting with special character '!', then it is a sortable encoding
            if (value[0] === '!') {
                value = parseInt(value.slice(1), 10) + Number.MIN_SAFE_INTEGER;
            } else {
                value = parseInt(value, 10);
            }
        }
        if (typeof value === 'number') {
            return this.validate(value);
        }
        throw new ValidationError(`Invalid integer value`);
    }
    public encode(value: N): string {
        return this.serialize(value).toFixed(0);
    }
    public decode(value: string): N {
        return this.deserialize(value);
    }
}

class ConstantField<K extends number> extends IntegerField<K> {
    constructor(private choices: K[]) {
        super({});
    }
    public validate(value: number): K {
        const v = super.validate(value) as K;
        if (this.choices.indexOf(v) >= 0) {
            return v;
        }
        throw new ValidationError(`Value is not one of the valid options`);
    }
    public serialize(value: K): K {
        return this.validate(value);
    }
    public deserialize(value: unknown): K {
        return super.deserialize(value) as K;
    }
    public encode(value: K): string {
        return super.encode(value);
    }
    public decode(value: string): K {
        return this.deserialize(value);
    }
    public encodeSortable(value: K): string {
        return super.encodeSortable(value);
    }
    public decodeSortable(value: string): K {
        return super.decodeSortable(value) as K;
    }
}

class BooleanField extends BaseField<boolean> implements Field<boolean> {
    public readonly type: string = 'boolean';
    public validate(value: boolean): boolean {
        return value;
    }
    public deserialize(value: unknown): boolean {
        if (typeof value === 'boolean') {
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
    public decode(value: string): boolean {
        if (value === 'true') {
            return true;
        } else if (value === 'false') {
            return false;
        }
        throw new ValidationError(`Invalid encoded boolean value`);
    }
}

class DateTimeField extends BaseField<Date, string> implements Field<Date, string> {
    public readonly type: string = 'timestamptz';
    public validate(value: Date): Date {
        return value;
    }
    public serialize(value: Date): string {
        return value.toISOString();
    }
    public deserialize(value: unknown): Date {
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
    public decode(value: string): Date {
        return this.deserialize(value);
    }
}

class DateField extends BaseField<Date, string> implements Field<Date, string> {
    public readonly type: string = 'date';
    public validate(value: Date): Date {
        return new Date(
            value.getFullYear(),
            value.getMonth(),
            value.getDate(),
        );
    }
    public serialize(value: Date): string {
        return value.toISOString().slice(0, 'YYYY-MM-DD'.length);
    }
    public deserialize(value: unknown): Date {
        if (typeof value !== 'string') {
            throw new ValidationError(`Date must be a string`);
        }
        // Try to parse the date from the string
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!match) {
            throw new ValidationError(`Invalid date format`);
        }
        const [, yearStr, monthStr, dateStr] = match;
        return new Date(
            parseInt(yearStr, 10),
            parseInt(monthStr, 10) - 1,
            parseInt(dateStr, 10),
        );
    }
    public encode(value: Date): string {
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
    public readonly type: string = 'numeric';
    private numberField = new NumberField({});
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
    public deserialize(value: unknown): string {
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
    public readonly type: string = 'uuid';
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

class DataUriField extends BaseField<DecodedDataUri, string> implements Field<DecodedDataUri, string> {
    public readonly type: string = 'bytea';
    public validate(value: DecodedDataUri): DecodedDataUri {
        if (!value.contentType) {
            throw new ValidationError(`Missing data content type`);
        }
        return value;
    }
    public serialize(value: DecodedDataUri): string {
        return this.encode(value);
    }
    public deserialize(value: unknown): DecodedDataUri {
        if (typeof value !== 'string') {
            throw new ValidationError(`Invalid string value`);
        }
        return this.decode(value);
    }
    public encode(value: DecodedDataUri): string {
        return encodeDataUri(value);
    }
    public decode(value: string): DecodedDataUri {
        return decodeDataUri(value);
    }
}

function isNullable(value: unknown): value is null | '' {
    return value === null || value === '';
}

/**
 * Makes the given field nullable, allowing null values for it.
 * It also means that any blank value, e.g. an empty string, will
 * always be converted to null.
 *
 * Useful to be used with string(), datetime() and integer() fields.
 */
class NullableField<I, O> implements Field<I | null, O | null> {
    public readonly type: string = this.field.type;
    constructor(public readonly field: Field<I, O>) {}
    public validate(value: I | null): I | null {
        return !isNullable(value) && this.field.validate(value) || null;
    }
    public serialize(value: I | null): O | null {
        return !isNullable(value) && this.field.serialize(value) || null;
    }
    public deserialize(value: unknown): I | null {
        return isNullable(value) ? null : this.field.deserialize(value);
    }
    public encode(value: I | null): string {
        return !isNullable(value) && this.field.encode(value) || '';
    }
    public decode(value: string): I | null {
        return !isNullable(value) && this.field.decode(value) || null;
    }
    public encodeSortable(value: I): string {
        return !isNullable(value) && this.field.encodeSortable(value) || '';
    }
    public decodeSortable(value: string): I | null {
        return !isNullable(value) && this.field.decodeSortable(value) || null;
    }
    public pack(value: I | null): unknown {
        return !isNullable(value) && this.field.pack(value) || null;
    }
    public unpack(value: unknown): I | null {
        return isNullable(value) ? null : this.field.unpack(value);
    }
}

class ListField<I, O> implements Field<I[], O[]> {
    public readonly type: string = this.field.type === 'jsonb' ? 'jsonb' : `${this.field.type}[]`;
    constructor(public readonly field: Field<I, O>) {}
    public validate(items: I[]): I[] {
        return this.mapWith(items, (item) => this.field.validate(item));
    }
    public serialize(items: I[]): O[] {
        return this.mapWith(items, (item) => this.field.serialize(item));
    }
    public deserialize(items: unknown): I[] {
        if (items && Array.isArray(items)) {
            return this.mapWith(items, (item) => this.field.deserialize(item));
        }
        throw new ValidationError(`Value is not an array`);
    }
    public encode(value: I[]): string {
        return this.mapWith(value, (item) => encodeURIComponent(this.field.encode(item))).join('&');
    }
    public decode(value: string): I[] {
        // TODO: Should differentiate an empty array vs. an array with a blank value!
        const items = value ? value.split('&') : [];
        return this.mapWith(items, (item) => this.field.decode(decodeURIComponent(item)));
    }
    public encodeSortable(value: I[]): string {
        return this.mapWith(value, (item) => encodeURIComponent(this.field.encodeSortable(item))).join('&');
    }
    public decodeSortable(value: string): I[] {
        // TODO: Should differentiate an empty array vs. an array with a blank value!
        const items = value ? value.split('&') : [];
        return this.mapWith(items, (item) => this.field.decodeSortable(decodeURIComponent(item)));
    }
    public pack(items: I[]): unknown {
        return this.mapWith(items, (item) => this.field.pack(item));
    }
    public unpack(items: unknown): I[] {
        if (items && Array.isArray(items)) {
            return this.mapWith(items, (item) => this.field.unpack(item));
        }
        throw new ValidationError(`Value is not an array`);
    }
    private mapWith<X, Y>(items: X[], iteratee: (item: X, index: number) => Y): Y[] {
        const errors: Array<KeyErrorData<number>> = [];
        const results = items.map((item, key) => {
            try {
                return iteratee(item, key);
            } catch (error) {
                // Collect nested validation errors
                if (isApiResponse(error)) {
                    errors.push({...error.data, key});
                } else {
                    // Pass through the error
                    throw error;
                }
            }
        });
        if (errors.length) {
            throw new ValidationError(`Invalid items`, errors);
        }
        return results as Y[];
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

export function integer(options: NumberFieldOptions = {}): Field<number> {
    return new IntegerField(options);
}

export function number(options: NumberFieldOptions = {}): Field<number> {
    return new NumberField(options);
}

export function decimal(decimals: number = 2): Field<string> {
    return new DecimalField(decimals);
}

export function boolean(): Field<boolean> {
    return new BooleanField();
}

export function matching(regexp: RegExp, errorMessage?: string): Field<string> {
    return new RegexpField(regexp, errorMessage);
}

export function datetime(): Field<Date, string> {
    return new DateTimeField();
}

export function date(): Field<Date, string> {
    return new DateField();
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

export function data(): Field<DecodedDataUri, string> {
    return new DataUriField();
}

export function nullable<I, O>(field: Field<I, O>): Field<I | null, O | null> {
    return new NullableField(field);
}

export function list<I, O>(field: Field<I, O>): Field<I[], O[]> {
    return new ListField(field);
}
