import * as assert from 'assert';
import 'mocha';
import { deal, findLastIndex, getOrderedIndex } from '../utils/arrays';

describe('findLastIndex', () => {
    it('returns the index of a matching item', () => {
        assert.equal(findLastIndex(['a', 'b', 'c'], (x) => x === 'b'), 1);
    });
    it('returns the index of a last matching item', () => {
        assert.equal(findLastIndex(['a', 'b', 'b', 'c'], (x) => x === 'b'), 2);
    });
    it('returns -1 if no matching item is found', () => {
        assert.equal(findLastIndex(['a', 'b', 'c'], (x) => x === 'd'), -1);
    });
    it('returns -1 for an empty array', () => {
        assert.equal(findLastIndex([], (x) => x === 'x'), -1);
    });
});

describe('getOrderedIndex', () => {
    it('inserts smallest item to the first index when ascending', () => {
        assert.equal(getOrderedIndex([{foo: 1}, {foo: 2}, {foo: 3}], {foo: 0}, 'foo', 'asc'), 0);
    });
    it('inserts largest item to the last index when ascending', () => {
        assert.equal(getOrderedIndex([{foo: 1}, {foo: 2}, {foo: 3}], {foo: 4}, 'foo', 'asc'), 3);
    });
    it('inserts smallest item to the last index when descending', () => {
        assert.equal(getOrderedIndex([{foo: 3}, {foo: 2}, {foo: 1}], {foo: 0}, 'foo', 'desc'), 3);
    });
    it('inserts largest item to the first index when descending', () => {
        assert.equal(getOrderedIndex([{foo: 3}, {foo: 2}, {foo: 1}], {foo: 4}, 'foo', 'desc'), 0);
    });
    it('inserts intermediate value to the correct index', () => {
        assert.equal(getOrderedIndex([{foo: 1}, {foo: 3}], {foo: 2}, 'foo', 'asc'), 1);
        assert.equal(getOrderedIndex([{foo: 3}, {foo: 1}], {foo: 2}, 'foo', 'desc'), 1);
    });
    it('inserts equal value after existing ones', () => {
        assert.equal(getOrderedIndex([{foo: 1}, {foo: 2}], {foo: 1}, 'foo', 'asc'), 1);
        assert.equal(getOrderedIndex([{foo: 2}, {foo: 1}], {foo: 2}, 'foo', 'desc'), 1);
    });
    it('inserts to an empty array', () => {
        assert.equal(getOrderedIndex([], {foo: 2}, 'foo', 'asc'), 0);
        assert.equal(getOrderedIndex([], {foo: 2}, 'foo', 'desc'), 0);
    });
});

describe('deal', () => {
    it('divides the array to chunks', () => {
        assert.deepEqual(
            deal(['a', 'b', 'c', 'd', 'e', 'f'], 3),
            [['a', 'b', 'c'], ['d', 'e', 'f']],
        );
        assert.deepEqual(
            deal(['a', 'b', 'c', 'd', 'e', 'f'], 2),
            [['a', 'b'], ['c', 'd'], ['e', 'f']],
        );
    });
    it('prefers equally sized chunks', () => {
        assert.deepEqual(
            deal(['a', 'b', 'c', 'd', 'e', 'f'], 5),
            [['a', 'b', 'c'], ['d', 'e', 'f']],
        );
        assert.deepEqual(
            deal(['a', 'b', 'c', 'd', 'e', 'f'], 4),
            [['a', 'b', 'c'], ['d', 'e', 'f']],
        );
    });
    it('makes last chunk smaller if cannot divide equally', () => {
        assert.deepEqual(
            deal(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 5),
            [['a', 'b', 'c', 'd'], ['e', 'f', 'g']],
        );
        assert.deepEqual(
            deal(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 2),
            [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g']],
        );
    });
    it('returns empty array for an empty parameter', () => {
        assert.deepEqual(deal([], 3), []);
    });
    it('throws an error if the max chunk size is zero', () => {
        assert.throws(() => deal(['a', 'b'], 0));
        assert.throws(() => deal([], 0));
    });
    it('throws an error if the max chunk size is negative', () => {
        assert.throws(() => deal(['a', 'b'], -1));
        assert.throws(() => deal([], -2));
    });
});
