export function upperFirst(str: string) {
    return str.replace(/^\w/i, (letter) => letter.toLocaleUpperCase());
}
