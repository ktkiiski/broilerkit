import * as path from 'path';

export async function* retrievePages<D, E, T extends keyof D>(request: AWS.Request<D, E>, key: T) {
    while (true) {
        const response = await request.promise();
        const { $response } = response;
        const { data } = $response;
        if (data) {
            yield data[key];
        }
        if (!$response.hasNextPage()) {
            break;
        }
        request = $response.nextPage(undefined as any) as AWS.Request<D, E>;
    }
}

export function formatS3KeyName(filename: string, extension?: string): string {
    const realExtension = path.extname(filename);
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
