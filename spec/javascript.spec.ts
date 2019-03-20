import * as assert from 'assert';
import 'mocha';
import { toJavaScript } from '../javascript';

describe('toJavaScript()', () => {
    it('converts a string', () => {
        assert.equal(
            toJavaScript('Ekke ekke ekke ptang zooboing!'),
            `"Ekke ekke ekke ptang zooboing!"`,
        );
    });
    it('converts a number', () => {
        assert.equal(toJavaScript(123), `123`);
        assert.equal(toJavaScript(-123), `-123`);
        assert.equal(toJavaScript(0.123), `0.123`);
        assert.equal(toJavaScript(-0.123), `-0.123`);
        assert.equal(toJavaScript(0), `0`);
        assert.equal(toJavaScript(-0), `-0`);
    });
    it('converts a boolean', () => {
        assert.equal(toJavaScript(true), `true`);
        assert.equal(toJavaScript(false), `false`);
    });
    it('converts a null', () => {
        assert.equal(toJavaScript(null), `null`);
    });
    it('converts a undefined', () => {
        assert.equal(toJavaScript(undefined), `undefined`);
    });
    it('converts a Date object', () => {
        assert.equal(toJavaScript(new Date(1234)), `new Date(1234)`);
    });
    it('converts an array', () => {
        assert.equal(
            toJavaScript([123, 'asdf', true, null, undefined]),
            `[123,"asdf",true,null,undefined]`,
        );
    });
    it('converts an object', () => {
        assert.equal(
            toJavaScript({
                aaa: 'asdf',
                bbb: 123,
                ccc: true,
                ddd: null,
                eee: undefined,
            }),
            `{"aaa":"asdf","bbb":123,"ccc":true,"ddd":null,"eee":undefined}`,
        );
    });
    it('indents an array with objects', () => {
        assert.equal(
            toJavaScript([
                {foo: 'bar', asdf: 'qwerty'},
                {ekke: 123, isCool: true},
            ], 4),
            `[
    {
        "foo": "bar",
        "asdf": "qwerty"
    },
    {
        "ekke": 123,
        "isCool": true
    }
]`,
        );
    });
    it('indents an object with arrays', () => {
        assert.equal(
            toJavaScript({
                foo: ['bar', 123, true],
                bar: ['asdf', 456, false],
            }, 4),
            `{
    "foo": [
        "bar",
        123,
        true
    ],
    "bar": [
        "asdf",
        456,
        false
    ]
}`,
        );
    });
});
