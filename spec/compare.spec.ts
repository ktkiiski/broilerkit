import * as assert from 'assert';
import 'mocha';
import { isEqual } from '../utils/compare';

describe('isEqual()', () => {
    it('returns true for two null values', () => {
        assert.ok(isEqual(null, null));
    });
    it('returns false for null and undefined', () => {
        assert.ok(!isEqual(null, undefined));
    });
    it('returns true for equal integers', () => {
        assert.ok(isEqual(123, 123));
    });
    it('returns false for unequal integers', () => {
        assert.ok(!isEqual(123, -123));
    });
    it('returns true for objects with equal attributes', () => {
        assert.ok(
            isEqual(
                {name: 'John', age: 1},
                {name: 'John', age: 1},
            ),
        );
    });
    it('returns false for objects with unequal attributes', () => {
        assert.ok(
            !isEqual(
                {name: 'John', age: 1},
                {name: 'Jane', age: 1},
            ),
        );
    });
    it('returns false for objects with different properties', () => {
        assert.ok(
            !isEqual(
                {name: 'John', foo: 'Z'},
                {name: 'John', bar: 'Z'},
            ),
        );
    });
    it('returns true for objects with recursive equal attributes', () => {
        const a: any = {name: 'John'};
        a.self = a;
        const b: any = {name: 'John'};
        b.self = b;
        assert.ok(isEqual(a, b));
    });
    it('returns true for objects with cross-referencing attributes', () => {
        const a: any = {name: 'John'};
        const b: any = {name: 'John', ref: a};
        a.ref = b;
        assert.ok(isEqual(a, b));
    });
    it('returns true for objects with deep recursive equal attributes', () => {
        const a1: any = {name: 'John 1'};
        const a2: any = {name: 'John 2', ref: a1};
        a1.ref = a2;
        const b1: any = {name: 'John 1'};
        const b2: any = {name: 'John 2', ref: b1};
        b1.ref = b2;
        assert.ok(isEqual(a1, b1));
    });
    it('returns false for objects with recursive unequal attributes', () => {
        const a: any = {name: 'John'};
        a.self = a;
        a.x = 'XXX';
        const b: any = {name: 'John'};
        b.self = b;
        b.x = 'YYY';
        assert.ok(!isEqual(a, b));
    });
    it('returns false for objects with deep recursive unequal attributes', () => {
        const a1: any = {name: 'John 1'};
        const a2: any = {name: 'John 2', ref: a1, x: 'XXX'};
        a1.ref = a2;
        const b1: any = {name: 'John 1'};
        const b2: any = {name: 'John 2', ref: b1, x: 'YYY'};
        b1.ref = b2;
        assert.ok(!isEqual(a1, b1));
    });
});
