import { BadRequest, parseHeaderDirectives, UnsupportedMediaType } from './http';
import { parseFormData } from './multipart';
import { Upload } from './uploads';
import { buildObject } from './utils/objects';
import { countBytes } from './utils/strings';

export function parsePayload(body: string, contentTypeHeader: string): any {
    const [contentType, meta] = parseHeaderDirectives(contentTypeHeader);
    if (contentType === 'plain/text') {
        // Deserialize as a string
        return body;

    } else if (contentType === 'application/json') {
        // Deserialize JSON
        // NOTE: An empty string is interpreted as an empty object!
        return body ? parseJSON(body) : {};

    } else if (contentType === 'multipart/form-data') {
        // Decode multipart/form-data
        const formData = parseFormData(body, meta.boundary);
        // tslint:disable-next-line:no-shadowed-variable
        return buildObject(formData, ({name, headers, filename, body}) => {
            if (!name) {
                return undefined;
            }
            const { 'Content-Type': type = 'text/plain' } = headers;
            if (filename != null) {
                // This is an uploaded file
                const size = countBytes(body);
                const file: Upload = { name: filename, type, body, size };
                return [name, file];
            }
            // Parse the value
            return [name, parsePayload(body, type)];
        });
    }
    throw new UnsupportedMediaType(`Content type '${contentType}' is unsupported`);
}

function parseJSON(body: string) {
    try {
        return JSON.parse(body);
    } catch {
        throw new BadRequest(`Invalid JSON payload`);
    }
}
