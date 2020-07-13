/* eslint-disable @typescript-eslint/no-explicit-any */
import build from 'immuton/build';
import { encodeDataUri } from './data-uri';
import { BadRequest, parseHeaderDirectives, UnsupportedMediaType } from './http';
import { parseFormData } from './multipart';
import { Serializer } from './serializers';

export function parsePayload<I>(serializer: Serializer<I, any>, body: string, contentTypeHeader: string): I {
    const [contentType, meta] = parseHeaderDirectives(contentTypeHeader);
    if (contentType === 'application/json') {
        // Deserialize JSON
        // NOTE: An empty string is interpreted as an empty object!
        const serializedPayload = body ? parseJSON(body) : {};
        return serializer.deserialize(serializedPayload);
    } else if (contentType === 'multipart/form-data') {
        // Decode multipart/form-data
        const formData = parseFormData(body, meta.boundary);
        const encodedPayload = build(formData, ({ name, headers, filename, body }) => {
            if (!name) {
                return undefined;
            }
            if (filename != null) {
                const { 'Content-Type': typeHeader = 'application/octet-stream' } = headers;
                const [fileType, fileMeta] = parseHeaderDirectives(typeHeader);
                // This is an uploaded file
                return [
                    name,
                    encodeDataUri({
                        data: body,
                        contentType: fileType,
                        meta: { ...fileMeta, filename },
                    }),
                ];
            }
            return [name, body];
        });
        return serializer.decode(encodedPayload);
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
