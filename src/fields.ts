import isFinite = require('lodash/isFinite');
import isString = require('lodash/isString');
import isBoolean = require('lodash/isBoolean');
// tslint:disable:max-classes-per-file

export interface IField<T> {
    deserialize(value: any): T;
}

export interface IFieldOptions<T> {
    allowNull?: boolean;
    required?: boolean;
    defaultValue?: T;
}

export abstract class Field<T> implements IField<T> {

    private allowNull: boolean;
    private required: boolean;
    private defaultValue: T | undefined;

    constructor(options: IFieldOptions<T> = {}) {
        const {allowNull = false, required = true, defaultValue} = options;
        this.allowNull = allowNull;
        this.required = required;
        this.defaultValue = defaultValue;
    }

    public deserialize(value: any): T {
        if (value === undefined) {
            if (this.required) {
                throw new Error(`The field is required`);
            }
            return this.defaultValue as T;
        } else if (value === null) {
            if (this.allowNull) {
                return value;
            }
            throw new Error(`The value null is not allowed`);
        } else {
            return value;
        }
    }
}

export class StringField extends Field<string> {
    public deserialize(value: any): string {
        const deserialized = super.deserialize(value);
        return deserialized == null ? deserialized : String(deserialized);
    }
}

export class IntegerField extends Field<number> {
    public deserialize(value: any): number {
        const deserialized = super.deserialize(value);
        if (deserialized == null) {
            return deserialized;
        } else if (isFinite(deserialized)) {
            return Math.floor(deserialized);
        } else if (isString(deserialized)) {
            return parseInt(deserialized, 10);
        } else {
            throw new Error(`Invalid integer value`);
        }
    }
}

export class BooleanField extends Field<boolean> {
    public deserialize(value: any): boolean {
        if (isBoolean(value)) {
            return value;
        }
        throw new Error(`Invalid boolean value`);
    }
}
