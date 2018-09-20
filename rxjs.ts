import { PartialObserver, Unsubscribable } from 'rxjs';

export interface Observablish<T> {
    subscribe(observer?: PartialObserver<T>): Unsubscribable;
}
