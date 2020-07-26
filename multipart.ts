import pick from 'immuton/pick';
import { ValidationError } from './errors';
import { parseHeaderDirectives, parseHeaders } from './http';
import { splitOnce } from './strings';

interface MultipartData {
    name?: string;
    filename?: string;
    headers: { [header: string]: string };
    body: string;
}

export function parseFormData(body: string, boundary: string): MultipartData[] {
    if (!boundary) {
        throw new ValidationError('Missing the multipart/form-data boundary');
    }
    // \r\n is part of the boundary.
    // eslint-disable-next-line no-param-reassign
    boundary = `\r\n--${boundary}`;

    // Prepend what has been stripped by the body parsing mechanism.
    // eslint-disable-next-line no-param-reassign
    body = `\r\n${body}`;

    const parts = body.split(boundary);
    // There must be at least one match (= two parts)
    if (parts.length < 2) {
        throw new ValidationError(`Invalid multipart/form-data payload: boundary not found`);
    }
    // First part must be a preamble
    parts.shift();
    // Last part is closing '--'
    parts.pop();
    return parts.map((part) => {
        const [headersStr, value] = splitOnce(part, '\r\n\r\n');
        if (typeof value === 'undefined') {
            throw new ValidationError(`Invalid multipart/form-data part: no content`);
        }
        const { 'Content-Disposition': contentDisposition, ...headers } = parseHeaders(headersStr);
        const headerFields = parseContentDisposition(contentDisposition);
        return {
            ...headerFields,
            headers,
            body: value,
        };
    });
}

function parseContentDisposition(header: string) {
    if (!header) {
        throw new ValidationError(`Invalid multipart/form-data part: missing Content-Disposition header`);
    }
    const [directive, meta] = parseHeaderDirectives(header);
    if (directive !== 'form-data') {
        throw new ValidationError(`Invalid multipart/form-data part: invalid Content-Disposition header`);
    }
    return pick(meta, ['name', 'filename']);
}
