/**
 * Export the native Symbol, if available, or otherwise the polyfill implementation
 * as the default export.
 */
// tslint:disable-next-line:no-string-literal
const globalSymbol = (window as any)['Symbol'];
const isSymbolImplemented = typeof globalSymbol === 'function' && typeof globalSymbol() === 'symbol';

export const Symbol: SymbolConstructor = isSymbolImplemented ? globalSymbol : require('es6-symbol/polyfill');

// If the Symbol.asyncIterator is not implemented, polyfill it
if (!Symbol.asyncIterator) {
    (Symbol as any).asyncIterator = Symbol.for('Symbol.asyncIterator');
}
