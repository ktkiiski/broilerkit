import * as childProcess from 'child_process';

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
        if (/[^A-Za-z0-9_\/:=-]/.test(s)) {
            s = '\'' + s.replace(/'/g, '\'\\\'\'') + '\'';
            s = s.replace(/^(?:'')+/g, '') // unduplicate single-quote at the beginning
                .replace(/\\'''/g, '\\\''); // remove non-escaped single-quote if there are enclosed between 2 escaped
        }
        ret.push(s);
    });
    return ret.join(' ');
}
