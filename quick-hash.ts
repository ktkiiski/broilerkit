export function hashCode(str: string, hash: number = 0) {
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

export function encodeHash(code: number) {
    return (
        ((code & 0xf0000000) >>> 28).toString(16) +
        ((code & 0x0f000000) >>> 24).toString(16) +
        ((code & 0x00f00000) >>> 20).toString(16) +
        ((code & 0x000f0000) >>> 16).toString(16) +
        ((code & 0x0000f000) >>> 12).toString(16) +
        ((code & 0x00000f00) >>> 8).toString(16) +
        ((code & 0x000000f0) >>> 4).toString(16) +
        (code & 0x0000000f).toString(16)
    );
}
