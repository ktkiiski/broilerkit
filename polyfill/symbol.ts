// Intentional side effects: ensure that core-js has backfilled Symbol
import 'core-js/library/modules/es6.symbol';
import 'core-js/library/modules/es7.symbol.async-iterator';
/**
 * Export the native Symbol, if available, or otherwise the polyfill implementation.
 */
export const Symbol: SymbolConstructor = require('core-js/library/modules/_core').Symbol;
