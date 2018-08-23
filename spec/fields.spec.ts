import * as assert from 'assert';
import 'mocha';
import { integer } from '../fields';

describe('field', () => {
    describe('integer()', () => {
        const field = integer();
        describe('encodeSortable()', () => {
            it('should encode positive integer', () => {
                assert.equal(field.encodeSortable(12345), '+0000000000012345');
            });
            it('should encode negative integer', () => {
                assert.equal(field.encodeSortable(-12345), '!9007199254728646');
            });
            it('should always return sortable values', () => {
                assert(field.encodeSortable(-435746797) < field.encodeSortable(-370676145));
                assert(field.encodeSortable(-370676145) < field.encodeSortable(-129709395));
                assert(field.encodeSortable(-129709395) < field.encodeSortable(-61921345));
                assert(field.encodeSortable(-61921345) < field.encodeSortable(0));
                assert(field.encodeSortable(0) < field.encodeSortable(29393476));
                assert(field.encodeSortable(29393476) < field.encodeSortable(114884294));
                assert(field.encodeSortable(114884294) < field.encodeSortable(205894032));
                assert(field.encodeSortable(205894032) < field.encodeSortable(338966509));
                assert(field.encodeSortable(338966509) < field.encodeSortable(344012632));
                assert(field.encodeSortable(344012632) < field.encodeSortable(462786638));
            });
        });
    });
});
