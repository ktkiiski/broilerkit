import { useEffect, useState } from 'react';
import { Observable } from 'rxjs';

export function useObservable<R>(
    defaultValue: R,
    observe: () => Observable<R>,
    deps: any[],
): R {
    const [result, setResult] = useState(defaultValue);
    useEffect(
        () => {
            const subscription = observe().subscribe(setResult);
            return () => subscription.unsubscribe();
        },
        deps,
    );
    return result;
}
