import * as del from 'del';
import * as path from 'path';

export function clean(dirPath: string): Promise<string[]> {
    const glob = path.join(dirPath, '**/*');
    return del(glob);
}
