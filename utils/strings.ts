export function upperFirst(str: string) {
    return str.replace(/^\w/i, (letter) => letter.toLocaleUpperCase());
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
