import { fromEvent, merge, Observable, Subject } from 'rxjs';

export class Location extends Observable<string> {
    private subject = new Subject<string>();
    private change$ = merge(
        fromEvent(window, 'popstate'),
        fromEvent(window, 'hashchange'),
        this.subject,
    );
    constructor(private prefix: string = '') {
        super((subscriber) => {
            let path = this.get();
            if (path != null) {
                subscriber.next(path);
            }
            return this.change$.subscribe(() => {
                const newPath = this.get();
                if (newPath !== path) {
                    path = newPath;
                    if (path != null) {
                        subscriber.next(path);
                    }
                }
            }, (error) => {
                subscriber.error(error);
            });
        });
    }
    public push(path: string, title: string = '') {
        const fullPath = this.prefix + normalizeUrl(path);
        history.pushState(null, title, fullPath);
        this.subject.next(fullPath);
    }
    public replace(path: string, title: string = '') {
        const fullPath = this.prefix + normalizeUrl(path);
        history.replaceState(null, title, fullPath);
        this.subject.next(fullPath);
    }
    public get(): string | null {
        const {prefix} = this;
        const path = normalizeUrl(location.pathname + location.search);
        if (path.startsWith(prefix)) {
            return path.slice(prefix.length);
        }
        return null;
    }
}

function normalizeUrl(path: string) {
    // Remove the trailing slash (or right before `?`)
    path = path.replace(/\/+($|\?)/, '');
    // Remove the hash completely
    path = path.replace(/#.*$/, '');
    // Remove any trailing `?` (if its the first `?`)
    if (path.indexOf('?') === path.length - 1) {
        path = path.slice(0, path.length - 1);
    }
    // Ensure that the path starts with a slash
    path = path.replace(/^\/?/, '/');
    return path;
}
