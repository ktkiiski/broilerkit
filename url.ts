// tslint:disable:no-shadowed-variable
import { keys, omit } from './utils/objects';

const urlPlaceholderRegexp = /^\{(.+)\}$/;

/**
 * Converts a URL path pattern to a RegExp that can be used to
 * check if a URL path matches the pattern. The match object
 * will contain each placeholder as a capturing group.
 *
 * @param pattern URL pattern with {xxx} placeholders
 */
export function makeUrlRegexp(pattern: string): RegExp {
    const regexpComponents = pattern.split('/').map(
        (component) => urlPlaceholderRegexp.test(component)
            ? '([^/]+)' // capturing group
            : escapeRegExp(component),
    );
    return new RegExp(`^${regexpComponents.join('/')}$`);
}

/**
 * An object describing an URL path and query parameters as an object.
 */
export class Url {
    constructor(public readonly path: string, public readonly queryParams: {[param: string]: string} = {}) {}

    public toString(): string {
        const {queryParams} = this;
        const sortedQueryKeys = keys(queryParams).sort();
        const queryItems = sortedQueryKeys.map(
            (key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`,
        );
        const query = queryItems.join('&');
        return this.path + (query && '?' + query);
    }
}

export class UrlPattern<T extends string = string> {
    public readonly pathKeywords: T[];
    private readonly regexp: RegExp;
    constructor(public readonly pattern: string) {
        const pathKeywords: T[] = [];
        const regexpComponents = pattern.split('/').map((component) => {
            const keywordMatch = urlPlaceholderRegexp.exec(component);
            if (keywordMatch) {
                pathKeywords.push(keywordMatch[1] as T);
                return '([^/]+)'; // capturing group
            }
            return escapeRegExp(component);
        });
        this.regexp = new RegExp(`^${regexpComponents.join('/')}$`);
        this.pathKeywords = pathKeywords;
    }

    public match(url: string | Url, defaults?: {[param: string]: string}): {[param: string]: string} | null {
        if (typeof url === 'string') {
            try {
                url = parseUrl(url);
            } catch {
                // Invalid URL -> do not match
                return null;
            }
        }
        const pathMatch = this.regexp.exec(url.path);
        if (!pathMatch) {
            return null;
        }
        const {pathKeywords} = this;
        const {length} = pathKeywords;
        const pathParameters: {[param: string]: string} = {};
        for (let i = 0; i < length; i++) {
            const pathKey = pathKeywords[i];
            try {
                pathParameters[pathKey] = decodeURIComponent(pathMatch[i + 1]);
            } catch {
                // Malformed URI component -> do not accept this URL
                return null;
            }
        }
        return {...defaults, ...url.queryParams, ...pathParameters};
    }

    public compile(urlParameters: {[key: string]: string}): Url {
        const queryParameters = {...urlParameters};
        const path = this.pattern.replace(/\{(\w+)\}/g, (_, urlKeyword: T) => {
            delete queryParameters[urlKeyword];
            return encodeURIComponent(urlParameters[urlKeyword]);
        });
        return new Url(path, queryParameters);
    }

    public compilePath(urlParameters: {[P in T]: string}) {
        return this.pattern.replace(/\{(\w+)\}/g, (_, urlKeyword: T) => (
            encodeURIComponent(urlParameters[urlKeyword])
        ));
    }

    public pickQueryParameters(urlParameters: {[key: string]: string}) {
        return omit(urlParameters, this.pathKeywords);
    }
}

export function pattern(strings: TemplateStringsArray): UrlPattern<never>;
export function pattern<T extends string>(strings: TemplateStringsArray, ...keywords: T[]): UrlPattern<T>;
export function pattern<T extends string>(strings: TemplateStringsArray, ...keywords: T[]) {
    return new UrlPattern<T>(buildUrl(strings, keywords));
}

export function parseUrl(url: string): Url {
    const [path, query] = url.split('?', 2);
    return new Url(path, parseQuery(query || ''));
}

export function parseQuery(query: string): {[key: string]: string} {
    query = query.replace(/^[#?]/, ''); // Strip any leading # or ?
    const result: {[key: string]: string} = {};
    for (const item of query.split('&')) {
        const [key, value] = item.split('=', 2);
        if (key && value != null) {
            result[decodeURIComponent(key)] = decodeURIComponent(value);
        }
    }
    return result;
}

function escapeRegExp(str: string) {
    return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}

function buildUrl(strings: TemplateStringsArray, keywords: string[]): string {
    const components: string[] = [];
    for (let i = 0; i < strings.length; i ++) {
        components.push(strings[i]);
        if (i < keywords.length) {
            components.push(`{${keywords[i]}}`);
        }
    }
    return components.join('');
}
