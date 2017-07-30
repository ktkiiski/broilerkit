import * as del from 'del';
import * as path from 'path';
import { Observable } from 'rxjs';

export function clean(dirPath: string): Observable<string[]> {
    const glob = path.join(dirPath, '**/*');
    return Observable.defer(() => del(glob));
}
