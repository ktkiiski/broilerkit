import * as assert from 'assert';
import 'mocha';
import { list, number, string } from '../fields';
import { FieldSerializer, nested } from '../serializers';
import { isEqual } from '../utils/compare';

describe('serializer', () => {
    describe('gathers nested validation errors', () => {
        const serializer = new FieldSerializer({
            name: string(),
            index: number(),
            tags: list(string()),
            nested: nested(new FieldSerializer({
                id: string(),
            })),
        });
        const input = {
            name: '',
            index: 0,
            tags: [''],
            nested: {
                id: '',
            },
        };
        const expectedErrorData = {
                message: `Invalid fields`,
                errors: [{
                    message: `Value may not be blank`,
                    key: 'name',
                }, {
                    message: `Invalid items`,
                    key: 'tags',
                    errors: [{
                        message: `Value may not be blank`,
                        key: 0,
                    }],
                }, {
                    message: `Invalid fields`,
                    key: 'nested',
                    errors: [{
                        message: `Value may not be blank`,
                        key: 'id',
                    }],
                }],
        };
        it('from validate()', () => {
            assert.throws(
                () => serializer.validate(input),
                (error: any) => isEqual(error.data, expectedErrorData),
            );
        });
        it('from serialize()', () => {
            assert.throws(
                () => serializer.serialize(input),
                (error: any) => isEqual(error.data, expectedErrorData),
            );
        });
        it('from deserialize()', () => {
            assert.throws(
                () => serializer.serialize(input),
                (error: any) => isEqual(error.data, expectedErrorData),
            );
        });
    });
});
