import * as assert from 'assert';
import 'mocha';
import { groupBy, groupByAsMap } from '../utils/groups';

describe('groupBy()', () => {
    it('returns empty object when given an empty array', () => {
        assert.deepStrictEqual(
            groupBy([], () => 'foo'),
            {},
        );
    });
    it('groups values with different selector results to different keys', () => {
        assert.deepStrictEqual(
            groupBy([
                {id: 1, name: 'John'},
                {id: 2, name: 'Eric'},
                {id: 3, name: 'Bob'},
            ], (item) => item.name),
            {
                John: [{id: 1, name: 'John'}],
                Eric: [{id: 2, name: 'Eric'}],
                Bob: [{id: 3, name: 'Bob'}],
            },
        );
    });
    it('group values with the same selector result to the same key', () => {
        assert.deepStrictEqual(
            groupBy([
                {id: 1, name: 'John'},
                {id: 2, name: 'John'},
                {id: 3, name: 'John'},
            ], (item) => item.name),
            {
                John: [
                    {id: 1, name: 'John'},
                    {id: 2, name: 'John'},
                    {id: 3, name: 'John'},
                ],
            },
        );
    });
});
describe('groupByAsMap()', () => {
    it('returns empty Map when given an empty array', () => {
        const result = groupByAsMap([], () => 'foo');
        assert.ok(result instanceof Map);
        assert.equal(result.size, 0);
    });
    it('groups values with different selector results to different keys', () => {
        const result = groupByAsMap(
            [
                {id: 1, name: 'John'},
                {id: 2, name: 'Eric'},
                {id: 3, name: 'Bob'},
            ],
            (item) => item.name,
        );
        assert.deepStrictEqual(
            Array.from(result.entries()),
            [
                ['John', [{id: 1, name: 'John'}]],
                ['Eric', [{id: 2, name: 'Eric'}]],
                ['Bob', [{id: 3, name: 'Bob'}]],
            ],
        );
    });
    it('group values with the same selector result to the same key', () => {
        const result = groupByAsMap(
            [
                {id: 1, name: 'John'},
                {id: 2, name: 'John'},
                {id: 3, name: 'John'},
            ],
            (item) => item.name,
        );
        assert.deepStrictEqual(
            Array.from(result.entries()),
            [
                ['John', [
                    {id: 1, name: 'John'},
                    {id: 2, name: 'John'},
                    {id: 3, name: 'John'},
                ]],
            ],
        );
    });
});
