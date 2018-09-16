import * as fs from 'fs';
import * as path from 'path';
import * as File from 'vinyl';
import { src as _src, SrcOptions } from 'vinyl-fs';

/**
 * Creates an observable that emits all entries matching the given
 * glob patterns as vinyl files. Wrapper for vinyl-fs/src!
 * @param globs an array of glob patterns
 * @returns observable for matching vinyl-files
 */
export function src(globs: string[], opts?: SrcOptions): Promise<File[]> {
    return readStream(_src(globs, opts));
}

/**
 * Searches the given directory matching the given glob patterns.
 * The search is performed also from all sub-directories.
 * @param dir The path of directory where the files are searched
 * @param patterns Array of glob patterns
 */
export function searchFiles(dir: string, patterns: string[]): Promise<File[]> {
    const baseDir = path.resolve(process.cwd(), dir);
    // If the first pattern is exclusion, prepend an all-matching pattern
    if (patterns.length && patterns[0].startsWith('!')) {
        patterns = ['**/*', ...patterns];
    }
    return src(patterns, {
        cwd: baseDir, // Search from the given directory
        cwdbase: true, // Emitted files are relative to the base directory
        nodir: true, // Ignore directories
    });
}

export function readFile(filename: string): Promise<string> {
    return new Promise((resolve, reject) => {
        fs.readFile(filename, (error, data) => {
            if (error) {
                reject(error);
            } else {
                let result;
                try {
                    result = String(data);
                } catch (strError) {
                    reject(strError);
                }
                resolve(result);
            }
        });
    });
}

export function writeFile(filename: string, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
        fs.writeFile(filename, data, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve(data);
            }
        });
    });
}

export function readStream(stream: NodeJS.ReadableStream): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const results: any[] = [];
        stream.on('end', () => resolve(results));
        stream.on('error', (error) => reject(error));
        stream.on('data', (item) => { results.push(item); });
    });
}

export async function readJSONFile(filename: string, defaultValue?: any): Promise<any> {
    try {
        const json = await readFile(filename);
        return JSON.parse(json);
    } catch (error) {
        if (typeof defaultValue === 'undefined') {
            throw error;
        }
        return defaultValue;
    }
}

export async function writeJSONFile(filename: string, data: any): Promise<any> {
    await ensureDirectoryExists(path.dirname(filename));
    await writeFile(filename, JSON.stringify(data, null, 4));
    return data;
}

export function createDirectory(dirPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.mkdir(dirPath, (error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

export async function ensureDirectoryExists(dirPath: string) {
    dirPath = path.normalize(dirPath);
    // Recursively ensure that the parent directory exists
    const parentDir = path.dirname(dirPath);
    if (parentDir && parentDir !== '/' && parentDir !== dirPath) {
        await ensureDirectoryExists(parentDir);
    }
    // Attempt to create the directory
    try {
        await createDirectory(dirPath);
    } catch (error) {
        // Ignore error if already exists, otherwise rethrow
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}
