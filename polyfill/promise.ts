/**
 * Export the native Promise, if available, or otherwise the polyfill implementation.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const Promise: PromiseConstructor = require('core-js-pure/features/promise');
