// Intentional side effects: ensure that async iterator Symbol is defined
import 'core-js-pure/features/symbol/async-iterator.js';
/**
 * Export the native Symbol, if available, or otherwise the polyfill implementation.
 */
export const Symbol: SymbolConstructor = require('core-js-pure/features/symbol').default;
