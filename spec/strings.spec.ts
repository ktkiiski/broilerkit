import * as assert from 'assert';
import 'mocha';
import { findAllMatches, shortenSentences } from '../utils/strings';

describe('shorten()', () => {
    it('should not shorten string with smaller length', () => {
        assert.equal(shortenSentences('Ekke!', 10), 'Ekke!');
        assert.equal(shortenSentences('Ekke!', 5), 'Ekke!');
    });
    it('should shorten long string', () => {
        assert.equal(shortenSentences('Ekke. Ptang zoo boing!', 6), 'Ekke.');
        assert.equal(shortenSentences('Ekke! Ptang zoo boing?', 10), 'Ekke!');
        assert.equal(shortenSentences('Ekke? Ptang zoo boing.', 12), 'Ekke?');
    });
    it('results to empty string if no split point found', () => {
        assert.equal(shortenSentences('Ekke ptang zoo boing!', 6), '');
    });
    it('uses the given replacement string', () => {
        assert.equal(shortenSentences('Ekke. Ptang zoo boing!', 6, '…'), 'Ekke…');
        assert.equal(shortenSentences('Ekke! Ptang zoo boing?', 10, '…'), 'Ekke…');
        assert.equal(shortenSentences('Ekke? Ptang zoo boing.', 12, '…'), 'Ekke…');
    });
    it('only removes the last cut sentence', () => {
        assert.equal(shortenSentences('Ekke. Ekke! Ekke? Ptang zoo boing.', 28), 'Ekke. Ekke! Ekke?');
    });
});

describe('findAllMatches()', () => {
    it('returns all matches of RegExp', () => {
        assert.deepEqual(
            findAllMatches(`W/"67ab43", "54ed21", "7892dd"`, /"[^"]*"/g),
            [`"67ab43"`, `"54ed21"`, `"7892dd"`],
        );
    });
    it('returns the given capture group values', () => {
        assert.deepEqual(
            findAllMatches(`W/"67ab43", "54ed21", "7892dd"`, /"([^"]*)"/g, 1),
            [`67ab43`, `54ed21`, `7892dd`],
        );
    });
    it('returns empty array if no matches', () => {
        assert.deepEqual(
            findAllMatches(`W/"67ab43", "54ed21", "7892dd"`, /'[^"]*'/g), [],
        );
    });
});
