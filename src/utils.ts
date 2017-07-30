import * as fs from 'fs';
import * as path from 'path';
import { Observable } from 'rxjs';
import * as File from 'vinyl';
import { src, SrcOptions } from 'vinyl-fs';
import * as YAML from 'yamljs';

/**
 * Creates an observable that emits all files matching the given
 * file patterns as vinyl files.
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

export function require$<T>(id: string): Observable<T> {
    return call$(() => require(id));
}

export function call$<T>(callback: () => T): Observable<T> {
    return new Observable<T>((subscriber) => {
        try {
            subscriber.next(callback() as T);
            subscriber.complete();
        } catch (error) {
            subscriber.error(error);
        }
    });
}

export function readConfig$<T>(configFile: string): Observable<T> {
    const cwd = process.cwd();
    const configPath = path.resolve(cwd, configFile);
    if (/\.(ya?ml)$/.test(configPath)) {
        return readFile$(configPath).map((data) => YAML.parse(data));
    }
    return require$<T>(configPath);
}
