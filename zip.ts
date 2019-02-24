import JSZip = require('jszip');

/**
 * Zips the given data (e.g. a Buffer) as a ZIP archive containing
 * the data as a single file, with the given name.
 *
 * @param data to compress
 * @param filename for the file included in the archive
 * @returns a promise for the ZIP archive as a Buffer
 */
export function zip(data: any, filename: string): Promise<Buffer> {
    return zipAll([{data, filename}]);
}

/**
 * Zips all the given datas (e.g. Buffers) as a ZIP archive containing
 * the the data with their given names.
 *
 * @param files to compress
 * @returns a promise for the ZIP archive as a Buffer
 */
export function zipAll(files: Array<{data: any, filename: string}>): Promise<Buffer> {
    const jszip = new JSZip();
    for (const {data, filename} of files) {
        jszip.file(filename, data);
    }
    return jszip.generateAsync({type: 'nodebuffer'});
}
