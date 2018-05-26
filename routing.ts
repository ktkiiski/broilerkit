import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Location } from './location';
import { observe } from './react';
import { Route } from './routes';

export interface State<T, K extends keyof T = keyof T> {
    name: K;
    params: T[K];
}

export class Router<T> extends Observable<State<T> | null> {
    constructor(private location: Location, private routings: {[P in keyof T]: Route<T[P], keyof T[P]>}) {
        super((subscriber) => {
            return this.location
                .pipe(map((url) => this.match(url)))
                .subscribe(subscriber)
            ;
        });
    }
    public push<K extends keyof T>(routeName: K, params: T[K]): void {
        const routing = this.routings[routeName];
        this.location.push(routing.compile(params).toString());
    }
    public replace<K extends keyof T>(routeName: K, params: T[K]): void {
        const routing = this.routings[routeName];
        this.location.replace(routing.compile(params).toString());
    }
    public match(url: string): State<T> | null {
        const routings = this.routings;
        for (const name in routings) {
            if (routings[name] != null) {
                try {
                    const params = routings[name].match(url);
                    if (params != null) {
                        return {name, params};
                    }
                } catch {
                    // Ignore deserialization error
                }
            }
        }
        return null;
    }
    public components(mappings: {[P in keyof T]?: (params: T[P]) => JSX.Element | null}, options?: {default: () => JSX.Element | null}) {
        const defaultRenderer = options && options.default;
        const renderer$ = this.pipe(
            map((state) => {
                if (!state) {
                    return null;
                }
                const render = mappings[state.name];
                if (!render) {
                    return null;
                }
                return {...state, render};
            }),
        );
        return observe(renderer$, (state) => state && state.render
            ? state.render(state.params)
            : defaultRenderer && defaultRenderer(),
        );
    }
}
