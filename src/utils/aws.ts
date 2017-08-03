import { map } from 'lodash';
import * as path from 'path';
import { Observable } from 'rxjs';

/**
 * Converts an object of parameter key-values to an
 * array of stack parameter objects.
 * @param parameters An object of parameter key-values
 * @returns Array of parameter objects.
 */
export function convertStackParameters(parameters: {[key: string]: any}) {
    return map(
        parameters,
        (ParameterValue, ParameterKey) => ({ParameterKey, ParameterValue}),
    );
}

/**
 * Converts a AWS.Request instance to an Observable.
 */
export function sendRequest$<D, E>(request: AWS.Request<D, E>): Observable<D> {
    return new Observable<D>((subscriber) => {
        request.send((error, data) => {
            if (error) {
                subscriber.error(error);
            } else {
                subscriber.next(data);
                subscriber.complete();
            }
        });
    });
}

export function formatS3KeyName(filename: string): string {
    const extension = path.extname(filename);
    const dirname = path.dirname(filename);
    const basename = path.basename(filename, extension);
    return path.join(dirname, `${basename}${extension}`);
}
