import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Location } from './location';
import { Route } from './routes';
import { Url } from './url';
import { Key } from './utils/objects';

export interface State<T, K extends Key<T> = Key<T>> {
    name: K;
    params: T[K];
}

export class Router<T> extends Observable<State<T> | null> {
    constructor(private location: Location, private routings: {[P in keyof T]: Route<T[P], Key<T[P]>>}) {
        super((subscriber) => {
            return this.location
                .pipe(map((url) => this.match(url)))
                .subscribe(subscriber)
            ;
        });
    }
    /**
     * Changes to the given state, with the given parameters,
     * adding it to the browsing history.
     * @param routeName name of the state to transition to
     * @param params parameters for the transitioned state
     */
    public push<K extends keyof T>(routeName: K, params: T[K]): void {
        this.location.push(this.buildUrl(routeName, params));
    }
    /**
     * Changes to the given state, with the given parameters,
     * replacing the topmost state in the browsing history.
     * @param routeName name of the state to transition to
     * @param params parameters for the transitioned state
     */
    public replace<K extends keyof T>(routeName: K, params: T[K]): void {
        this.location.replace(this.buildUrl(routeName, params));
    }
    /**
     * Parses the given URL and returns the routing state that it matches.
     * If the URL matches no defined route, returns null.
     * @param url URL to parse
     */
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
    /**
     * Returns an URL string (with path and any query parameters)
     * for the given router state name and parameters.
     * @param routeName name of the state
     * @param params parameters required by the state
     */
    public buildUrl<K extends keyof T>(routeName: K, params: T[K]): string {
        return this.compileUrl(routeName, params).toString();
    }
    /**
     * Returns an URL object for the given router state name and parameters.
     * @param routeName name of the state
     * @param params parameters required by the state
     */
    public compileUrl<K extends keyof T>(routeName: K, params: T[K]): Url {
        const routing = this.routings[routeName];
        return routing.compile(params);
    }
}
