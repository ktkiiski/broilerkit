/**
 * Export the native Symbol, if available, or otherwise the polyfill implementation
 * as the default export.
 */
// tslint:disable-next-line:no-string-literal
const globalSymbol = (window as any)['Symbol'];
const isSymbolImplemented = typeof globalSymbol === 'function' && typeof globalSymbol() === 'symbol';

export const Symbol: SymbolConstructor = isSymbolImplemented ? globalSymbol : require('es6-symbol/polyfill');

for (const propName of ['iterator', 'asyncIterator']) {
    if (!(Symbol as any)[propName]) {
        Object.defineProperty(Symbol, propName, {
            value: Symbol.for(propName),
            configurable: false,
            enumerable: false,
            writable: false,
        });
    }
}
