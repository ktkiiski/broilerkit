import * as assert from 'assert';
import 'mocha';
import { shortenSentences } from '../utils/strings';

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
});
