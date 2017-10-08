import * as fs from 'fs';
import * as path from 'path';
import { Observable } from 'rxjs';
import * as File from 'vinyl';
import { src, SrcOptions } from 'vinyl-fs';

/**
 * Creates an observable that emits all entries matching the given
 * glob patterns as vinyl files. Wrapper for vinyl-fs/src!
 * @param globs an array of glob patterns
 * @returns observable for matching vinyl-files
 */
export function src$(globs: string[], opts?: SrcOptions): Observable<File> {
    return new Observable((subscriber) => {
        const stream = src(globs, opts);
        stream.on('end', () => subscriber.complete());
        stream.on('error', (error) => subscriber.error(error));
        stream.on('data', (file) => subscriber.next(file));
    });
}

/**
 * Searches the given directory matching the given glob patterns.
 * The search is performed also from all sub-directories.
 * @param dir The path of directory where the files are searched
 * @param patterns Array of glob patterns
 */
export function searchFiles$(dir: string, patterns: string[]): Observable<File> {
    const baseDir = path.resolve(process.cwd(), dir);
    // If the first pattern is exclusion, prepend an all-matching pattern
    if (patterns.length && patterns[0].startsWith('!')) {
        patterns = ['**/*', ...patterns];
    }
    return src$(patterns, {
        cwd: baseDir, // Search from the given directory
        cwdbase: true, // Emitted files are relative to the base directory
        nodir: true, // Ignore directories
    });
}

export function readFile$(filename: string): Observable<string> {
    return new Observable<string>((subscriber) => {
        fs.readFile(filename, (error, data) => {
            if (error) {
                subscriber.error(error);
            } else {
                try {
                    subscriber.next(String(data));
                    subscriber.complete();
                } catch (strError) {
                    subscriber.error(strError);
                }
            }
        });
    });
}
