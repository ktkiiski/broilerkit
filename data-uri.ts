import { ValidationError } from './errors';
import { parseHeaderDirectives } from './http';

interface DecodedDataUri {
    data: string;
    contentType: string;
    meta?: Record<string, string>;
}

export function encodeDataUri({data, contentType, meta = {}}: DecodedDataUri) {
    const chunks = ['data:'];
    // Add media type
    if (contentType) {
        chunks.push(contentType);
        // Add parameters
        Object.keys(meta).forEach((parameter) => {
            chunks.push(';', parameter, '=', meta[parameter]);
        });
    }
    chunks.push(',', data);
    return chunks.join('');
}

export function decodeDataUri(uri: string): DecodedDataUri {
    const regexp = /^data:(.*?),/g;
    const prefix = regexp.exec(uri);
    if (!prefix) {
        throw new ValidationError(`Value is not a valid data URI`);
    }
    const mediaType = prefix[1];
    if (/(^|;)base64$/.test(mediaType)) {
        throw new ValidationError(`Decoding base64 is not supported yet`);
    }
    const data = uri.slice(regexp.lastIndex);
    let [contentType, meta] = parseHeaderDirectives(mediaType);
    if (!contentType) {
        contentType = 'text/plain';
        meta = { charset: 'US-ASCII', ...meta };
    }
    return { data, contentType, meta };
}
