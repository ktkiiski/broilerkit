import { keys } from './utils/objects';

const urlPlaceholderRegexp = /^\{.+\}$/;

/**
 * Converts a URL path pattern to a RegExp that can be used to
 * check if a URL path matches the pattern. The match object
 * will contain each placeholder as a capturing group.
 *
 * @param urlPattern URL pattern with {xxx} placeholders
 */
export function makeUrlRegexp(urlPattern: string): RegExp {
    const regexpComponents = urlPattern.split('/').map(
        (component) => urlPlaceholderRegexp.test(component)
            ? '([^/]+)' // capturing group
            : escapeRegExp(component),
    );
    return new RegExp(`^${regexpComponents.join('/')}$`);
}

/**
 * Compiles the URL from the given components as a string, encoding and ordering the query
 * parameters to a consistent order.
 *
 * @param origin Host of the URL
 * @param path Path component of the URL
 * @param queryParameters Object of query parameters
 */
export function compileUrl(origin: string, path: string, queryParameters: {[key: string]: string}): string {
    const sortedQueryKeys = keys(queryParameters).sort();
    const urlBase = `${origin}${path}`;
    if (sortedQueryKeys.length) {
        const queryComponents = sortedQueryKeys.map(
            (key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParameters[key])}`,
        );
        return `${urlBase}?${queryComponents.join('&')}`;
    }
    return urlBase;
}

function escapeRegExp(str: string) {
    return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}
