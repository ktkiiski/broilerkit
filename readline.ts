import { createInterface } from 'readline';

/**
 * Writes a question to stdout and waits until the user writes a line of input
 * and presses enter. The returned promise is resolved with the written answer.
 * It may be an empty string.
 * @param question The question to ask from the user.
 * @param trim Whether or not to strip leading and trailing whitespace.
 */
export function readAnswer(question: string, trim = true): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(question + ' ', (answer) => {
            try {
                rl.close();
                resolve(trim ? answer.trim() : answer);
            } catch (e) {
                reject(e);
            }
        });
    });
}
