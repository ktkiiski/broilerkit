import { encodeSafeJSON } from './html';
import { keys } from './objects';
import { repeat } from './strings';

/**
 * Converts the given value to a JavaScript expression that once evaluated
 * equals to the original value. The result is similar to JSON.stringify(...)
 * but may also contain Date, NaN, Infinity values, and undefined values.
 * The returned expression is safe to be inserted to a HTML <script> tag.
 *
 * @param value the value to convert to a JavaScript expression
 * @param indent optional amount of indentation for pretty print
 * @returns JavaScript expression as a string
 */
export function toJavaScript(value: unknown, indent?: number): string {
    const buffer: string[] = [];
    buildJavaScript(buffer, value, '', indent == null ? null : repeat(' ', indent));
    return buffer.join('');
}

function buildJavaScript(buffer: string[], value: unknown, baseIndent: string, indent: string | null) {
    if (typeof value === 'string' || typeof value === 'boolean') {
        buffer.push(encodeSafeJSON(value));
    } else if (typeof value === 'number') {
        if (Number.isNaN(value)) {
            buffer.push(`NaN`);
        } else if (!Number.isFinite(value)) {
            buffer.push(value < 0 ? `-Infinity` : `Infinity`);
        } else if (Object.is(value, -0)) {
            buffer.push(`-0`);
        } else {
            buffer.push(encodeSafeJSON(value));
        }
    } else if (typeof value === 'undefined') {
        buffer.push(`undefined`);
    } else if (value instanceof Date) {
        buffer.push(`new Date(`);
        buildJavaScript(buffer, value.getTime(), baseIndent, indent);
        buffer.push(`)`);
    } else if (typeof value === 'object') {
        const nextIndent = indent ? baseIndent + indent : baseIndent;
        if (value === null) {
            buffer.push(`null`);
        } else if (Array.isArray(value)) {
            buffer.push(`[`);
            value.forEach((item, index) => {
                if (index > 0) {
                    buffer.push(',');
                }
                if (indent != null) {
                    buffer.push('\n');
                    buffer.push(nextIndent);
                }
                buildJavaScript(buffer, item, nextIndent, indent);
            });
            if (indent != null) {
                buffer.push(`\n`);
                buffer.push(baseIndent);
            }
            buffer.push(`]`);
        } else {
            buffer.push(`{`);
            keys(value).forEach((key: string, index) => {
                if (index > 0) {
                    buffer.push(',');
                }
                if (indent != null) {
                    buffer.push('\n');
                    buffer.push(nextIndent);
                }
                buffer.push(encodeSafeJSON(key));
                buffer.push(':');
                if (indent != null) {
                    buffer.push(' ');
                }
                buildJavaScript(buffer, value[key as keyof typeof value], nextIndent, indent);
            });
            if (indent != null) {
                buffer.push(`\n`);
                buffer.push(baseIndent);
            }
            buffer.push(`}`);
        }
    }
}
