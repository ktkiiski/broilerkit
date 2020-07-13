import * as path from 'path';
import { AmazonS3 } from './aws/s3';
import { ACL, Bucket } from './buckets';
import { ensureDirectoryExists, readFile, readFileBuffer, writeFile } from './fs';
import { HandlerServerContext } from './handlers';
import { BadRequest, HttpMethod, HttpRequest, HttpResponse, NotFound } from './http';
import { parsePayload } from './parser';
import { Controller } from './server';
import { Trigger, triggerEvent } from './triggers';
import { UploadForm, uploadFormSerializer, uploadSerializer } from './uploads';
import { pattern, Url } from './url';
import { uuid4 } from './uuid';

interface UploadConfig {
    access: ACL;
    maxSize: number;
    expiresIn: number;
    userId: string | null;
    contentType?: string;
}

interface BucketObject {
    key: string;
    bucket: Bucket;
    data: Buffer;
    userId: string | null;
}

export interface FileStorage {
    allowUpload(bucket: Bucket, config: UploadConfig): Promise<UploadForm>;
    retrieve(bucket: Bucket, key: string): Promise<BucketObject>;
}

export class AWSFileStorage implements FileStorage {
    private s3 = new AmazonS3(this.region);
    constructor(private readonly stackName: string, private readonly region: string) {}
    public async allowUpload(bucket: Bucket, config: UploadConfig): Promise<UploadForm> {
        const { userId, ...options } = config;
        const presignedPost = await this.s3.createPresignedPost({
            ...options,
            bucketName: this.getBucketName(bucket),
            successActionStatus: 201,
            key: generateKey(),
            meta: userId ? { 'user-id': userId } : {},
        });
        return {
            'Content-Type': null,
            'Content-Disposition': null,
            ...presignedPost.fields,
            action: presignedPost.url,
            method: 'POST',
        } as UploadForm;
    }
    public async retrieve(bucket: Bucket, key: string): Promise<BucketObject> {
        const bucketName = this.getBucketName(bucket);
        const { body: data, meta } = await this.s3.getObject(bucketName, key);
        const userId = meta['user-id'] || null;
        return { bucket, data, key, userId };
    }
    private getBucketName(bucket: Bucket): string {
        // The deployed S3 bucket starts with the stack name
        return `${this.stackName}-storage-${bucket.name}`;
    }
}

export class LocalFileStorage implements FileStorage {
    constructor(private serverOrigin: string, private rootPath: string) {}
    public async allowUpload(bucket: Bucket, config: UploadConfig): Promise<UploadForm> {
        const now = new Date();
        return uploadFormSerializer.validate({
            acl: config.access,
            key: generateKey(),
            action: `${this.serverOrigin}/__upload/${encodeURIComponent(bucket.name)}`,
            method: 'POST',
            success_action_status: '201',
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
            'X-Amz-Credential': getAmzCredential('XXXXXXXX', 'local', now),
            'Content-Disposition': null,
            'Content-Type': null,
            'X-Amz-Date': getAmzDate(now),
            'X-Amz-Meta-user-id': config.userId,
            Policy: 'LOCAL_POLICY',
            'X-Amz-Signature': 'LOCAL_SIGNATURE',
            'X-Amz-Security-Token': 'LOCAL_SECURITY_TOKEN',
        });
    }
    public async retrieve(bucket: Bucket, key: string): Promise<BucketObject> {
        const filePath = path.join(this.rootPath, bucket.name, key);
        const metaFilePath = path.join(this.rootPath, bucket.name, '.meta', key);
        try {
            const [buffer, metaJson] = await Promise.all([readFileBuffer(filePath), readFile(metaFilePath)]);
            const meta = JSON.parse(metaJson);
            return {
                key,
                data: buffer,
                bucket,
                userId: meta['user-id'] || null,
            };
        } catch {
            throw new NotFound(`File ${key} not found.`);
        }
    }
}

export const LOCAL_UPLOAD_ENDPOINT_NAME = 'localUpload';

export class LocalUploadController implements Controller {
    public readonly methods: HttpMethod[] = ['POST'];
    public readonly pattern = pattern`/__upload/${'bucket'}`;
    constructor(private rootPath: string) {}
    public async execute(request: HttpRequest, context: HandlerServerContext): Promise<HttpResponse> {
        const url = new Url(request.path, request.queryParameters);
        const match = this.pattern.match(url) as { [key: string]: string };
        const bucketName = match.bucket;
        const { 'Content-Type': contentTypeHeader = 'multipart/form-data' } = request.headers;
        const body = request.body ? request.body.toString() : '';
        const size = request.body ? request.body.length : 0;
        const payload = parsePayload(uploadSerializer, body, contentTypeHeader);
        const { 'X-Amz-Signature': signature, file, Policy } = payload;
        const { 'X-Amz-Security-Token': securityToken } = payload;
        const { 'X-Amz-Meta-user-id': userId, key } = payload;
        if (signature !== 'LOCAL_SIGNATURE') {
            throw new BadRequest('Invalid signature');
        }
        if (Policy !== 'LOCAL_POLICY') {
            throw new BadRequest('Invalid policy');
        }
        if (securityToken !== 'LOCAL_SECURITY_TOKEN') {
            throw new BadRequest('Invalid security token');
        }
        const filePath = path.join(this.rootPath, bucketName, key);
        const metaFilePath = path.join(this.rootPath, bucketName, '.meta', key);
        const dirPath = path.dirname(filePath);
        const metaDirPath = path.dirname(metaFilePath);
        const { 'Content-Type': contentType, 'Content-Disposition': contentDisposition } = file.meta || {};
        const meta: { [key: string]: string } = {
            key,
            acl: payload.acl,
            'Content-Length': String(size),
        };
        if (userId != null) {
            meta['user-id'] = userId;
        }
        if (contentType) {
            meta['Content-Type'] = contentType;
        }
        if (contentDisposition) {
            meta['Content-Disposition'] = contentDisposition;
        }
        await ensureDirectoryExists(dirPath);
        await ensureDirectoryExists(metaDirPath);
        await Promise.all([writeFile(filePath, file.data), writeFile(metaFilePath, JSON.stringify(meta))]);
        // Trigger the handler (asyncrhonously)
        this.triggerEvent(context, bucketName, key, size);
        return {
            statusCode: parseInt(payload.success_action_status, 10),
            headers: {},
            body: '',
        };
    }
    private async triggerEvent(context: HandlerServerContext, bucketName: string, key: string, size: number) {
        const fakeBucketName = `${context.stackName}-storage-${bucketName}`;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const triggers: Trigger[] = Object.values(require('_triggers'));
        await triggerEvent(
            triggers,
            {
                Records: [
                    {
                        eventName: 'ObjectCreated:Post',
                        eventTime: new Date().toISOString(),
                        s3: {
                            bucket: { name: fakeBucketName },
                            object: { key, size },
                        },
                    },
                ],
            },
            context,
        );
    }
}

function generateKey() {
    return uuid4().replace(/^\w\w/, (m) => `${m}/`);
}

function getAmzCredential(accountId: string, region: string, now: Date) {
    const date = now.toISOString().slice(0, 'YYYY-MM-DD'.length).replace(/-/g, '');
    return `${accountId}/${date}/${region}/s3/aws4_request`;
}

function getAmzDate(now: Date) {
    return now.toISOString().replace(/[-:]|\.\d+/g, '');
}
