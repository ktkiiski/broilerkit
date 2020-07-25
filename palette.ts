import type * as Styles from 'ansi-styles';
import type * as Support from 'supports-color';

const noFormat = (str: string): string => str;

let blue = noFormat;
let bold = noFormat;
let cyan = noFormat;
let dim = noFormat;
let green = noFormat;
let magenta = noFormat;
let red = noFormat;
let underline = noFormat;
let yellow = noFormat;

function stylize(modifier: { open: string; close: string }) {
    return (str: string) => `${modifier.open}${str}${modifier.close}`;
}

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const styles: typeof Styles = require('ansi-styles');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stdout, stderr }: typeof Support = require('supports-color');
    const isSupported = stdout && stdout.has256 && stderr && stderr.has256 && !process.env.AWS_LAMBDA_LOG_GROUP_NAME;
    if (isSupported) {
        blue = stylize(styles.blue);
        bold = stylize(styles.bold);
        cyan = stylize(styles.cyan);
        dim = stylize(styles.dim);
        green = stylize(styles.green);
        magenta = stylize(styles.magenta);
        red = stylize(styles.red);
        underline = stylize(styles.underline);
        yellow = stylize(styles.yellow);
    }
} catch {
    // Coloring packages not available at this environment
}

export { blue, bold, cyan, dim, green, magenta, red, underline, yellow };
