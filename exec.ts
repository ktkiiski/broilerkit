/* eslint-disable no-param-reassign */
import * as childProcess from 'child_process';

/**
 * Executes a command, returning the output as a string,
 * with any trailing whitespace trimmed out.
 * @param cmd The command to execute
 */
export async function execute(cmd: string): Promise<string> {
    const output = await new Promise<string>((resolve, reject) => {
        childProcess.exec(cmd, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
    return output.trim();
}

/**
 * Launches a new process with the given command and arguments,
 * returning a promise that resolves if the process exists with zero
 * status code or rejects if the status code was non-zero.
 * @param cmd The command to execute
 * @param args Parameters for the command
 */
export async function spawn(cmd: string, args: string[] = []): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const process = childProcess.spawn(cmd, args, { stdio: 'inherit' });
        process.on('close', (code, signal) => {
            if (code) {
                reject(Object.assign(new Error(`Process exited with status code ${code}`), { code, signal }));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Executes a command synchronously, returning the output as a string,
 * with any trailing whitespace trimmed out.
 * @param cmd The command to execute
 */
export function executeSync(cmd: string): string {
    return childProcess.execSync(cmd).toString().trim();
}

/**
 * Escapes the string for shell.
 */
export function escapeForShell(...a: string[]): string {
    const ret: string[] = [];
    a.forEach((s) => {
        if (/[^A-Za-z0-9_/:=-]/.test(s)) {
            s = `'${s.replace(/'/g, "'\\''")}'`;
            s = s
                .replace(/^(?:'')+/g, '') // unduplicate single-quote at the beginning
                .replace(/\\'''/g, "\\'"); // remove non-escaped single-quote if there are enclosed between 2 escaped
        }
        ret.push(s);
    });
    return ret.join(' ');
}
