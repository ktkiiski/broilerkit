/**
 * Export the native Promise, if available, or otherwise the polyfill implementation.
 */
// tslint:disable-next-line:no-string-literal
export const Promise: PromiseConstructor = (window as any)['Promise'] || require('promise-polyfill').default;
// TODO: Set custom Promise._unhandledRejectionFn for unhandled rejections
