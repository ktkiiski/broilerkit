import * as path from 'path';

export async function* retrievePages<D, E, T extends keyof D>(
    request: AWS.Request<D, E>,
    key: T,
): AsyncGenerator<Exclude<D[T], undefined | null>, void> {
    while (true) {
        const response = await request.promise();
        const { $response } = response;
        const { data } = $response;
        if (data) {
            const result = data[key];
            if (result != null) {
                yield result as Exclude<D[T], undefined | null>;
            }
        }
        if (!$response.hasNextPage()) {
            break;
        }
        // eslint-disable-next-line no-param-reassign
        request = $response.nextPage(undefined) as AWS.Request<D, E>;
    }
}

export function formatS3KeyName(filename: string, extension?: string): string {
    const realExtension = path.extname(filename);
    // eslint-disable-next-line no-param-reassign
    extension = extension || realExtension;
    const dirname = path.dirname(filename);
    const basename = path.basename(filename, realExtension);
    return path.join(dirname, `${basename}${extension}`);
}

export function isDoesNotExistsError(error: Error): boolean {
    return !!error.message && error.message.indexOf('does not exist') >= 0;
}

export function isUpToDateError(error: Error): boolean {
    return !!error.message && error.message.indexOf('No updates are to be performed') >= 0;
}
