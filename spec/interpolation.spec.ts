import * as assert from 'assert';
import { tmpl } from '../interpolation';

describe('tmpl', () => {
    it('fills placeholders', () => {
        const interpolate = tmpl`Hello ${'name1'} and ${'name2'}!`;
        assert.equal(interpolate({ name1: 'John', name2: 'Jane' }), 'Hello John and Jane!');
    });
    it('stringifies numbers', () => {
        const interpolate = tmpl`${'name'} is ${'age'} years old`;
        assert.equal(interpolate({ name: 'John', age: 20 }), 'John is 20 years old');
    });
    it('works with just a placeholder', () => {
        const interpolate = tmpl`${'message'}`;
        assert.equal(interpolate({ message: 'Yay!' }), 'Yay!');
    });
    it('does not require placeholders', () => {
        const interpolate = tmpl`Hello!`;
        assert.equal(interpolate({}), 'Hello!');
    });
});
