/**
 * Export the native Promise, if available, or otherwise the polyfill implementation.
 */
export const Promise: PromiseConstructor = require('core-js-pure/features/promise').default;
