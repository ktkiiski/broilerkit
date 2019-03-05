import { ValidationError } from './errors';
import { normalizeHeaders, parseHeaderDirectives } from './http';
import { pick } from './utils/objects';
import { splitOnce } from './utils/strings';

interface MultipartData {
    name?: string;
    filename?: string;
    headers: {[header: string]: string};
    body: string;
}

/*
 * MultiPart_parse decodes a multipart/form-data encoded response into a named-part-map.
 * The response can be a string or raw bytes.
 *
 * Usage for string response:
 *      var map = MultiPart_parse(xhr.responseText, xhr.getResponseHeader('Content-Type'));
 *
 * Usage for raw bytes:
 *      xhr.open(..);
 *      xhr.responseType = "arraybuffer";
 *      ...
 *      var map = MultiPart_parse(xhr.response, xhr.getResponseHeader('Content-Type'));
 *
 * TODO: Can we use https://github.com/felixge/node-formidable
 * See http://stackoverflow.com/questions/6965107/converting-between-strings-and-arraybuffers
 * See http://www.w3.org/Protocols/rfc1341/7_2_Multipart.html
 *
 * Copyright@ 2013-2014 Wolfgang Kuehn, released under the MIT license.
*/
export function parseFormData(body: string, contentType: string): MultipartData[] {
    const [mimeType, meta] = parseHeaderDirectives(contentType);
    if (mimeType !== 'multipart/form-data') {
        throw new ValidationError('Expected Content-Type to be multipart/form-data');
    }
    if (!meta.boundary) {
        throw new ValidationError('Content-Type is missing the multipart boundary');
    }

    // \r\n is part of the boundary.
    const boundary = '\r\n--' + meta.boundary;

    // Prepend what has been stripped by the body parsing mechanism.
    body = '\r\n' + body;

    // TODO: Why wrapped with RegExp?
    const parts = body.split(boundary);

    // There must be at least one match!
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
        const {'Content-Disposition': contentDisposition, ...headers} = parseHeaders(headersStr.split('\r\n'));
        const headerFields = parseContentDisposition(contentDisposition);
        return {
            ...headerFields,
            headers,
            body: value,
        };
    });
}

function parseHeaders(headerLines: string[]) {
    const headers: Record<string, string> = {};
    for (const headerLine of headerLines) {
        const headerMatch = /^(.+?):\s*(.*)$/.exec(headerLine);
        if (headerMatch) {
            headers[headerMatch[1]] = headerMatch[2];
        }
    }
    return normalizeHeaders(headers);
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
