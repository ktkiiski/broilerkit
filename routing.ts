import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Location } from './location';
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
    /**
     * Changes to the given state, with the given parameters,
     * adding it to the browsing history.
     * @param routeName name of the state to transition to
     * @param params parameters for the transitioned state
     */
    public push<K extends keyof T>(routeName: K, params: T[K]): void {
        const routing = this.routings[routeName];
        this.location.push(routing.compile(params).toString());
    }
    /**
     * Changes to the given state, with the given parameters,
     * replacing the topmost state in the browsing history.
     * @param routeName name of the state to transition to
     * @param params parameters for the transitioned state
     */
    public replace<K extends keyof T>(routeName: K, params: T[K]): void {
        const routing = this.routings[routeName];
        this.location.replace(routing.compile(params).toString());
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
}
