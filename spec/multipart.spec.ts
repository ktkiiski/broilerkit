import * as assert from 'assert';
import hasProperties from 'immuton/hasProperties';
import 'mocha';
import { parseFormData } from '../multipart';

describe('parseFormData()', () => {
    it('parses values to their own fields', () => {
        assert.deepEqual(
            parseFormData(
                joinLines(
                    `------7dd322351017c`,
                    `Content-Disposition: form-data; name="field1"`,
                    ``,
                    `value1`,
                    `------7dd322351017c`,
                    `Content-Disposition: form-data; name="field2"; filename="example.txt"`,
                    ``,
                    `value2`,
                    `------7dd322351017c--`,
                ),
                `----7dd322351017c`,
            ),
            [
                { name: 'field1', body: 'value1', headers: {} },
                { name: 'field2', body: 'value2', filename: 'example.txt', headers: {} },
            ],
        );
    });
    it('supports parts without "name"', () => {
        assert.deepEqual(
            parseFormData(
                joinLines(
                    `------7dd322351017c`,
                    `Content-Disposition: form-data; name="field"`,
                    ``,
                    `value1`,
                    `------7dd322351017c`,
                    `Content-Disposition: form-data`,
                    ``,
                    `value2`,
                    `------7dd322351017c--`,
                ),
                `----7dd322351017c`,
            ),
            [
                { name: 'field', body: 'value1', headers: {} },
                { body: 'value2', headers: {} },
            ],
        );
    });
    it('supports unquoted directives', () => {
        assert.deepEqual(
            parseFormData(
                joinLines(
                    `------7dd322351017c`,
                    `Content-Disposition: form-data; name=field1`,
                    ``,
                    `value1`,
                    `------7dd322351017c`,
                    `Content-Disposition: form-data; name=field2; filename=example.txt`,
                    ``,
                    `value2`,
                    `------7dd322351017c--`,
                ),
                `----7dd322351017c`,
            ),
            [
                { name: 'field1', body: 'value1', headers: {} },
                { name: 'field2', body: 'value2', headers: {}, filename: 'example.txt' },
            ],
        );
    });
    it('supports multiline values', () => {
        assert.deepEqual(
            parseFormData(
                joinLines(
                    `------7dd322351017c`,
                    `Content-Disposition: form-data; name="field"`,
                    ``,
                    `line 1`,
                    `line 2`,
                    `line 3`,
                    ``,
                    `line 4`,
                    ``,
                    `------7dd322351017c--`,
                ),
                `----7dd322351017c`,
            ),
            [
                {
                    name: 'field',
                    headers: {},
                    body: joinLines(`line 1`, `line 2`, `line 3`, ``, `line 4`, ``),
                },
            ],
        );
    });
    it('returns all headers', () => {
        assert.deepEqual(
            parseFormData(
                joinLines(
                    `------7dd322351017c`,
                    `Content-Disposition: form-data; name="field"`,
                    `Content-Type: application/json`,
                    `Content-Length: 10`,
                    ``,
                    `1234567890`,
                    `------7dd322351017c--`,
                ),
                `----7dd322351017c`,
            ),
            [
                {
                    name: 'field',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': '10',
                    },
                    body: `1234567890`,
                },
            ],
        );
    });
    it('capitalizes header names', () => {
        assert.deepEqual(
            parseFormData(
                joinLines(
                    `------7dd322351017c`,
                    `content-disposition: form-data; name="field"`,
                    `content-type: application/json`,
                    `CONTENT-LENGTH: 10`,
                    ``,
                    `1234567890`,
                    `------7dd322351017c--`,
                ),
                `----7dd322351017c`,
            ),
            [
                {
                    name: 'field',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': '10',
                    },
                    body: `1234567890`,
                },
            ],
        );
    });
    it('returns empty array with empty payload', () => {
        assert.deepEqual(parseFormData(`------7dd322351017c--`, `----7dd322351017c`), []);
    });
    it('raises 400 error with non-matching boundary', () => {
        assert.throws(
            () =>
                parseFormData(
                    joinLines(
                        `------7dd322351017c`,
                        `Content-Disposition: form-data; name="field1"`,
                        ``,
                        `value1`,
                        `------7dd322351017c`,
                        `Content-Disposition: form-data; name="field2"; filename="example.txt"`,
                        ``,
                        `value2`,
                        `------7dd322351017c--`,
                    ),
                    `----ekke`,
                ),
            (error) =>
                hasProperties(error, {
                    statusCode: 400,
                    message: `Invalid multipart/form-data payload: boundary not found`,
                }),
        );
    });
    it('raises 400 with invalid part', () => {
        assert.throws(
            () =>
                parseFormData(
                    joinLines(
                        `------7dd322351017c`,
                        `ekke ekke ekke`,
                        `------7dd322351017c`,
                        `Content-Disposition: form-data; name="valid_field"`,
                        ``,
                        `valid value`,
                        `------7dd322351017c--`,
                    ),
                    `----7dd322351017c`,
                ),
            (error) =>
                hasProperties(error, {
                    statusCode: 400,
                    message: `Invalid multipart/form-data part: no content`,
                }),
        );
    });
    it('raises 400 with invalid Content-Disposition keyword', () => {
        assert.throws(
            () =>
                parseFormData(
                    joinLines(
                        `------7dd322351017c`,
                        `Content-Disposition: this-is-invalid; name="valid_field"`,
                        ``,
                        `valid value`,
                        `------7dd322351017c--`,
                    ),
                    `----7dd322351017c`,
                ),
            (error) =>
                hasProperties(error, {
                    statusCode: 400,
                    message: `Invalid multipart/form-data part: invalid Content-Disposition header`,
                }),
        );
    });
    it('raises 400 with invalid Content-Disposition header', () => {
        assert.throws(
            () =>
                parseFormData(
                    joinLines(
                        `------7dd322351017c`,
                        `Content-Disposition: 💩`,
                        ``,
                        `valid value`,
                        `------7dd322351017c--`,
                    ),
                    `----7dd322351017c`,
                ),
            (error) =>
                hasProperties(error, {
                    statusCode: 400,
                    message: `Invalid multipart/form-data part: invalid Content-Disposition header`,
                }),
        );
    });
    it('raises 400 with missing Content-Disposition header', () => {
        assert.throws(
            () =>
                parseFormData(
                    joinLines(
                        `------7dd322351017c`,
                        `Content-Type: application/json`,
                        ``,
                        `{"foo": "bar"}`,
                        `------7dd322351017c--`,
                    ),
                    `----7dd322351017c`,
                ),
            (error) =>
                hasProperties(error, {
                    statusCode: 400,
                    message: `Invalid multipart/form-data part: missing Content-Disposition header`,
                }),
        );
    });
    it('raises 400 with blank Content-Disposition header', () => {
        assert.throws(
            () =>
                parseFormData(
                    joinLines(
                        `------7dd322351017c`,
                        `Content-Disposition:`,
                        ``,
                        `{"foo": "bar"}`,
                        `------7dd322351017c--`,
                    ),
                    `----7dd322351017c`,
                ),
            (error) =>
                hasProperties(error, {
                    statusCode: 400,
                    message: `Invalid multipart/form-data part: missing Content-Disposition header`,
                }),
        );
    });
    it('raises 400 with missing boundary in the content type', () => {
        assert.throws(
            () =>
                parseFormData(
                    joinLines(
                        `------7dd322351017c`,
                        `Content-Disposition: form-data`,
                        ``,
                        `value`,
                        `------7dd322351017c--`,
                    ),
                    ``,
                ),
            (error) =>
                hasProperties(error, {
                    statusCode: 400,
                    message: `Missing the multipart/form-data boundary`,
                }),
        );
    });
});

function joinLines(...lines: string[]): string {
    return lines.join('\r\n');
}
