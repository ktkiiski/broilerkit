// tslint:disable:max-classes-per-file
import { Dictionary } from 'lodash';
import filter = require('lodash/filter');
import map = require('lodash/map');
import mapValues = require('lodash/mapValues');
import omit = require('lodash/omit');
import { Observable } from 'rxjs';
import { ajax } from 'rxjs/observable/dom/ajax';
import { Field } from './fields';
import { HttpMethod } from './http';

declare const __API_ORIGIN__: string;

export interface IApiDefinition<I> {
    auth: boolean;
    url: string;
    params: { [P in keyof I]: Field<I[P]> };
}

export interface IApiListPage<T> {
    next: string | null;
    results: T[];
}

export abstract class Api<I extends object> implements IApiDefinition<I> {
    public abstract readonly methods: HttpMethod[];
    public readonly auth: boolean;
    public readonly url: string;
    public readonly params: { [P in keyof I & string]: Field<I[P]> };

    protected readonly pathComponents: string[];
    protected readonly urlParams: Array<keyof I>;

    constructor(options: IApiDefinition<I>) {
        this.auth = options.auth;
        this.url = options.url;
        this.params = options.params;
        this.pathComponents = this.url.split('/');
        this.urlParams = filter(
            map(this.pathComponents, (component) => {
                const keywordMatch = /^{(\w+)}$/.exec(component);
                return (keywordMatch && keywordMatch[1]) as keyof I;
            }),
        );
    }

    public parseUrl(url: string): Partial<I> | null {
        const input: {[key: string]: any} = {};
        const patternComponents = this.pathComponents;
        const splittedUrl = url.split('/');
        if (patternComponents.length !== splittedUrl.length) {
            return null;
        }
        for (let i = 0; i < splittedUrl.length; i ++) {
            const urlComponent = splittedUrl[i];
            const patternComponent = patternComponents[i];
            const keywordMatch = /^{(\w+)}$/.exec(patternComponent);
            if (keywordMatch) {
                input[keywordMatch[1]] = decodeURIComponent(urlComponent);
            } else if (urlComponent !== patternComponent) {
                return null;
            }
        }
        return input as Partial<I>;
    }

    public getUrl(input: {[key: string]: any}): string {
        const path = this.url.replace(/{(\w+)}/g, (_, key) => {
            const value = input[key];
            if (value == null) {
                throw Error(`URL component "${key}" is missing a value.`);
            }
            return encodeURIComponent(value);
        });
        return `${__API_ORIGIN__}${path}`;
    }

    public deserialize(input: {[key: string]: any}): I {
        return mapValues(
            this.params as Dictionary<Field<any>>,
            (field, name) => field.deserialize(input[name]),
        ) as I;
    }
}

export class RetrieveApi<I extends object, O> extends Api<I> {

    public methods = ['GET', 'HEAD'] as HttpMethod[];

    public get(input: I): Observable<O> {
        // TODO: Validate
        const method = 'GET';
        const url = this.getUrl(input);
        return ajax({method, url}).map((response) => response.response as O);
    }
}

export class ListApi<I extends object, O> extends RetrieveApi<I, IApiListPage<O>> {

    public list(input: I): Observable<O> {
        return this.get(input)
            .expand((page) => {
                if (page.next) {
                    return ajax({method: 'GET', url: page.next}).map((response) => response.response as IApiListPage<O>);
                }
                return Observable.empty<IApiListPage<O>>();
            })
            .concatMap((page) => page.results)
        ;
    }
}

export class CreateApi<I extends object, O> extends Api<I> {

    public methods = ['POST'] as HttpMethod[];

    public post(input: I): Observable<O> {
        // TODO: Validate
        const method = 'POST';
        const url = this.getUrl(input);
        const body = JSON.stringify(omit(input, this.urlParams));
        return ajax({method, url, body}).map((response) => response.response as O);
    }
}

export class UpdateApi<I extends object, O> extends Api<I> {

    public methods = ['PUT', 'PATCH'] as HttpMethod[];

    public put(input: I): Observable<O> {
        // TODO: Validate
        const method = 'PUT';
        const url = this.getUrl(input);
        const body = JSON.stringify(omit(input, this.urlParams));
        return ajax({method, url, body}).map((response) => response.response as O);
    }

    public patch(input: Partial<I>): Observable<O> {
        // TODO: Validate
        const method = 'PATCH';
        const url = this.getUrl(input);
        const body = JSON.stringify(omit(input, this.urlParams));
        return ajax({method, url, body}).map((response) => response.response as O);
    }
}

export class DeleteApi<I extends object> extends Api<I> {
    public methods = ['DELETE'] as HttpMethod[];

    public delete(input: Partial<I>): Observable<never> {
        // TODO: Validate
        const method = 'DELETE';
        const url = this.getUrl(input);
        return ajax({method, url}).ignoreElements() as Observable<never>;
    }
}
