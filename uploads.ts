import { choice, data, nullable, string, url } from './fields';
import { Deserialization } from './resources';
import { serializer } from './serializers';

export const uploadFormSerializer = serializer({
    'action': url(),
    'method': choice(['POST' as const]),
    'acl': choice(['private', 'public-read']),
    'Content-Type': nullable(string()),
    'Content-Disposition': nullable(string()),
    'key': string(),
    'Policy': string(),
    'success_action_status': choice(['200', '201', '204']),
    'X-Amz-Algorithm': choice(['AWS4-HMAC-SHA256']),
    'X-Amz-Credential': string(),
    'X-Amz-Date': string(),
    'X-Amz-Signature': string(),
    'X-Amz-Security-Token': string(),
    'X-Amz-Meta-user-id': nullable(string()),
});

export type UploadForm = Deserialization<typeof uploadFormSerializer>;

export const uploadSerializer = uploadFormSerializer
    .omit(['action', 'method', 'Content-Type', 'Content-Disposition'])
    .extend({ file: data() });
