import * as childProcess from 'child_process';
import { Observable } from 'rxjs';

/**
 * Executes a command synchronously, returning the output as a string,
 * with any trailing whitespace trimmed out.
 * @param cmd The command to execute
 */
export function executeSync(cmd: string): string {
    return childProcess.execSync(cmd).toString().trim();
}

/**
 * Returns an Observable that once subscribes, will execute the given command
 * in a child process, emitting the output from the command as string chunks.
 * The observable will fail with exit status is non-zero.
 * @param cmd The command to execute
 */
export function execute$(cmd: string, log = true): Observable<string> {
    return new Observable<string>((subscriber) => {
        const child = childProcess.exec(cmd);
        child.stdout.on('data', (chunk) => {
            const output = chunk.toString();
            if (log) {
                process.stdout.write(output);
            }
            subscriber.next(output);
        });
        child.stderr.on('data', (chunk) => {
            const output = chunk.toString();
            if (log) {
                process.stderr.write(output);
            }
            subscriber.next(chunk.toString());
        });
        child.on('close', (exitStatus) => {
            if (exitStatus) {
                subscriber.error(Object.assign(
                    new Error(`Command execution failed with exit status ${exitStatus}`),
                    {code: exitStatus},
                ));
            } else {
                subscriber.complete();
            }
        });
        return () => child.kill();
    });
}
