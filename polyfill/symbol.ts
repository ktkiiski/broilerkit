// Intentional side effects: ensure that async iterator Symbol is defined
import 'core-js-pure/features/symbol/async-iterator';
/**
 * Export the native Symbol, if available, or otherwise the polyfill implementation.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const Symbol: SymbolConstructor = require('core-js-pure/features/symbol');
