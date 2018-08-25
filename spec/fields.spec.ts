import * as assert from 'assert';
import 'mocha';
import { integer, number } from '../fields';

describe('field', () => {
    describe('integer()', () => {
        const field = integer();
        describe('encodeSortable()', () => {
            it('should encode positive integer', () => {
                assert.equal(field.encodeSortable(12345), '040c81c8000000000');
                assert.equal(field.encodeSortable(123456789), '0419d6f3454000000');
            });
            it('should encode negative integer', () => {
                assert.equal(field.encodeSortable(-12345), '-bf37e37fffffffff');
                assert.equal(field.encodeSortable(-123456789), '-be6290cbabffffff');
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
        describe('decodeSortable()', () => {
            it('should decode positive integer', () => {
                assert.equal(field.decodeSortable('040c81c8000000000'), 12345);
                assert.equal(field.decodeSortable('0419d6f3454000000'), 123456789);
            });
            it('should decode negative integer', () => {
                assert.equal(field.decodeSortable('-bf37e37fffffffff'), -12345);
                assert.equal(field.decodeSortable('-be6290cbabffffff'), -123456789);
            });
        });
    });
    describe('number()', () => {
        const field = number();
        describe('encodeSortable()', () => {
            it('should encode positive number', () => {
                assert.equal(field.encodeSortable(12345.6789), '040c81cd6e631f8a1');
            });
            it('should encode negative number', () => {
                assert.equal(field.encodeSortable(-12345.6789), '-bf37e32919ce075e');
            });
            it('should always return sortable values', () => {
                assert(field.encodeSortable(-4357.46797) < field.encodeSortable(-3706.76145));
                assert(field.encodeSortable(-3706.76145) < field.encodeSortable(-129.709395));
                assert(field.encodeSortable(-129.709395) < field.encodeSortable(-0.61921345));
                assert(field.encodeSortable(-0.61921345) < field.encodeSortable(0));
                assert(field.encodeSortable(0) < field.encodeSortable(0.29393476));
                assert(field.encodeSortable(0.29393476) < field.encodeSortable(1.14884294));
                assert(field.encodeSortable(1.14884294) < field.encodeSortable(205.894032));
                assert(field.encodeSortable(205.894032) < field.encodeSortable(3389.66509));
                assert(field.encodeSortable(3389.66509) < field.encodeSortable(3440126.32));
                assert(field.encodeSortable(3440126.32) < field.encodeSortable(462786638));
            });
        });
        describe('decodeSortable()', () => {
            it('should decode positive number', () => {
                assert.equal(field.decodeSortable('040c81cd6e631f8a1'), 12345.6789);
            });
            it('should decode negative number', () => {
                assert.equal(field.decodeSortable('-bf37e32919ce075e'), -12345.6789);
            });
        });
    });
});
