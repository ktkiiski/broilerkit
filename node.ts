import { Observable } from 'rxjs/Observable';
import { Readable } from 'stream';

/**
 * Converts a NodeJS readable stream to an Observable that
 * emits all the chunks as strings. Note that this may emit one
 * or more chunk strings!
 *
 * @param stream A readable NodeJS stream
 */
export function readStreamChunks(stream: Readable): Observable<string> {
    return new Observable<string>((subscriber) => {
        stream.on('end', () => subscriber.complete());
        stream.on('data', (chunk) => subscriber.next(chunk.toString()));
        stream.on('error', (error) => subscriber.error(error));
    });
}

/**
 * Converts a NodeJS readable stream to an Observable that reads all the
 * data from the stream an then emits them as a single concatenated string.
 *
 * @param stream A readable NodeJS stream
 */
export function readStream(stream: Readable): Observable<string> {
    return readStreamChunks(stream)
        .toArray()
        .map((chunks) => chunks.join(''))
    ;
}
