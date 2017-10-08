import * as childProcess from 'child_process';

/**
 * Executes a command synchronously, returning the output as a string,
 * with any trailing whitespace trimmed out.
 * @param cmd The command to execute
 */
export function executeSync(cmd: string): string {
    return childProcess.execSync(cmd).toString().trim();
}
