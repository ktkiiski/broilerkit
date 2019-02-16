export function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;')
         .replace(/'/g, '&#039;')
    ;
}

export function encodeSafeJSON(...params: Parameters<typeof JSON.stringify>) {
    return JSON.stringify(...params).replace(/</g, '\x3C').replace(/>/g, '\x3E');
}
