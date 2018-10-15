import * as assert from 'assert';
import 'mocha';
import { findLastIndex } from '../utils/arrays';

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
