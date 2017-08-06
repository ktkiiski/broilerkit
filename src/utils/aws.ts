import { cyan, green, red } from 'chalk';
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

export function retrievePage$<D, E, T extends keyof D>(request: AWS.Request<D, E>, key: T): Observable<D[T]> {
    return new Observable<D[T]>((subscriber) => {
        request.eachPage((error, data) => {
            if (error) {
                subscriber.error(error);
            } else if (data) {
                subscriber.next(data[key]);
            } else {
                subscriber.complete();
            }
            return !subscriber.closed;
        });
    });
}

export function formatStatus(status: string): string {
    if (status.endsWith('_FAILED')) {
        return red(status);
    } else if (status.endsWith('_COMPLETE')) {
        return green(status);
    } else {
        return cyan(status);
    }
}

export function formatS3KeyName(filename: string): string {
    const extension = path.extname(filename);
    const dirname = path.dirname(filename);
    const basename = path.basename(filename, extension);
    return path.join(dirname, `${basename}${extension}`);
}

export function isDoesNotExistsError(error: Error): boolean {
    return !!error.message && error.message.indexOf('does not exist') >= 0;
}

export function isUpToDateError(error: Error): boolean {
    return !!error.message && error.message.indexOf('No updates are to be performed') >= 0;
}
