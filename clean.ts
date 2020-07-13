import * as fs from 'fs';
import * as path from 'path';
import { getFileStats } from './fs';

/**
 * Recursively and asynchronously deletes the given path or directory,
 * including all of its contents.
 * @param dirPath directory path
 */
export async function* clean(dirPath: string): AsyncIterableIterator<string> {
    if (!dirPath || dirPath === '/') {
        throw new Error(`Invalid directory path: ${dirPath}`);
    }
    try {
        const stats = await getFileStats(dirPath);
        if (!stats.isDirectory()) {
            // This is a file. Delete this.
            await unlinkFile(dirPath);
            yield dirPath;
            return;
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Does not exist! Nothing to remove!
            return;
        }
        throw error;
    }
    // List contents of the directory
    const contents = await readDirectory(dirPath);
    for (const fileName of contents) {
        // Recursively delete contents
        const filePath = path.join(dirPath, fileName);
        yield* clean(filePath);
    }
    // The directory should now be clean. Delete it
    await removeDirectory(dirPath);
}

function unlinkFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => fs.unlink(filePath, (error) => (error ? reject(error) : resolve())));
}
function removeDirectory(dirPath: string): Promise<void> {
    return new Promise((resolve, reject) => fs.rmdir(dirPath, (error) => (error ? reject(error) : resolve())));
}
function readDirectory(dirPath: string): Promise<string[]> {
    return new Promise((resolve, reject) =>
        fs.readdir(dirPath, (error, fileNames) => (error ? reject(error) : resolve(fileNames))),
    );
}
