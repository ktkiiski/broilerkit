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
    const jszip = new JSZip();
    jszip.file(filename, data);
    return jszip.generateAsync({type: 'nodebuffer'});
}
