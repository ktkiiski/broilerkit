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
    const padding = new Array(paddingCount + 1).join(padChars);
    return padding + str;
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
