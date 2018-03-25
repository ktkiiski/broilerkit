// Intentional side effects: ensure that core-js has backfilled Promise
import 'core-js/library/modules/es6.promise';
/**
 * Export the native Promise, if available, or otherwise the polyfill implementation.
 */
export const Promise: PromiseConstructor = require('core-js/library/modules/_core').Promise;
