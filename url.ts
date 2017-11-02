import map = require('lodash/map');

const urlPlaceholderRegexp = /^\{.+\}$/;

/**
 * Converts a URL path pattern to a RegExp that can be used to
 * check if a URL path matches the pattern. The match object
 * will contain each placeholder as a capturing group.
 *
 * @param urlPattern URL pattern with {xxx} placeholders
 */
export function makeUrlRegexp(urlPattern: string): RegExp {
    const regexpComponents = map(
        urlPattern.split('/'),
        (component) => urlPlaceholderRegexp.test(component)
            ? '([^/]+)' // capturing group
            : escapeRegExp(component),
    );
    return new RegExp(`^${regexpComponents.join('/')}$`);
}

function escapeRegExp(str: string) {
    return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}
