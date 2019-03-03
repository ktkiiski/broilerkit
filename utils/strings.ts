export function upperFirst(str: string) {
    return str.replace(/^\w/i, (letter) => letter.toLocaleUpperCase());
}

export function capitalize(str: string) {
    return upperFirst(str.toLocaleLowerCase());
}

export function padStart(str: string, minLength: number, padChars: string) {
    const paddingLength = minLength - str.length;
    if (paddingLength <= 0) {
        return str;
    }
    const paddingCount = Math.ceil(paddingLength / padChars.length);
    const padding = repeat(padChars, paddingCount);
    return padding + str;
}

export function padEnd(str: string, minLength: number, padChars: string) {
    const paddingLength = minLength - str.length;
    if (paddingLength <= 0) {
        return str;
    }
    const paddingCount = Math.ceil(paddingLength / padChars.length);
    const padding = repeat(padChars, paddingCount);
    return str + padding;
}

export function repeat(str: string, count: number): string {
    return new Array(count + 1).join(str);
}

const digits = '1234567890';
const lowerCaseAsciiLetters = 'abcdefghijklmnopqrstuvwxyz';
const upperCaseAsciiLetters = lowerCaseAsciiLetters.toUpperCase();
const asciiAlphanumeric = digits + lowerCaseAsciiLetters + upperCaseAsciiLetters;

export function randomize(length: number, chars: string = asciiAlphanumeric) {
    const comps: string[] = [];
    while (comps.length < length) {
        comps.push(chars[Math.floor(Math.random() * chars.length)]);
    }
    return comps.join('');
}

export function stripPrefix(str: string, prefix: string): string | null {
    const ln = prefix.length;
    if (str.slice(0, ln) === prefix) {
        return str.slice(ln);
    }
    return null;
}

const indentRegexp = /^/gm;

export function indent(str: string, indentation: number): string {
    return str.replace(indentRegexp, repeat(' ', indentation));
}

/**
 * Returns the number of bytes taken by the given Unicode string.
 * @param str Unicode string
 */
export function countBytes(str: string): number {
    // returns the byte length of an utf8 string
    let len = str.length;
    for (let i = str.length - 1; i >= 0; i--) {
      const code = str.charCodeAt(i);
      if (code > 0x7f && code <= 0x7ff) { len++; } else if (code > 0x7ff && code <= 0xffff) { len += 2; }
      if (code >= 0xDC00 && code <= 0xDFFF) { i--; } // trail surrogate
    }
    return len;
}

export function shortenSentences(str: string, maxLength: number, replacement?: string) {
    if (str.length <= maxLength) {
        return str;
    }
    str = str.slice(0, maxLength);
    const result = str.replace(
        /([.?!…]+)[^.?!…]*?$/,
        (_, term) => !term ? '' : replacement || term,
    );
    return result === str ? '' : result;
}

export function findAllMatches(str: string, regex: RegExp, group = 0): string[] {
    const results: string[] = [];
    let match: RegExpExecArray | null;
    // tslint:disable-next-line:no-conditional-assignment
    while (match = regex.exec(str)) {
        results.push(match[group]);
    }
    return results;
}
