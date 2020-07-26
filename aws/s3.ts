import { S3 } from 'aws-sdk';
import flatMap from 'immuton/flatMap';
import { chunkify } from '../async';
import { retrievePages } from './utils';

interface PresignPostOptions {
    bucketName: string;
    key: string;
    access: 'private' | 'public-read';
    maxSize: number;
    expiresIn: number;
    successActionStatus: 200 | 201 | 204;
    meta: { [key: string]: string };
    contentType?: string;
}

interface GetObjectResult {
    bucketName: string;
    key: string;
    body: Buffer;
    meta: S3.Metadata;
}

/**
 * Wrapper class for Amazon S3 operations with a reactive interface.
 */
export class AmazonS3 {
    private s3 = new S3({
        region: this.region,
        apiVersion: '2006-03-01',
        maxRetries: 20,
    });

    constructor(private region: string) {}

    /**
     * Retrieves a single object with its data from an S3 bucket.
     * @param bucketName name of the bucket
     * @param key object key
     */
    public async getObject(bucketName: string, key: string): Promise<GetObjectResult> {
        const object = await this.s3.getObject({ Bucket: bucketName, Key: key }).promise();
        const { Body, Metadata = {} } = object;
        return {
            bucketName,
            key,
            body: typeof Body === 'string' ? Buffer.from(Body) : (Body as Buffer),
            meta: Metadata,
        };
    }

    /**
     * Removes all the items from an Amazon S3 bucket so that it can be deleted.
     */
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public async *emptyBucket(bucketName: string) {
        // Delete regular objects (with null versions)
        for await (const objects of chunkify(this.iterateObjects(bucketName), 100)) {
            const refs = flatMap(objects, ({ Key }) => (Key ? [{ Key }] : []));
            const removals = await this.deleteMultipleS3Objects(bucketName, refs);
            yield* removals;
        }
        // Delete all object versions
        for await (const versions of chunkify(this.iterateObjectVersions(bucketName), 100)) {
            const refs = flatMap(versions, ({ Key, VersionId }) => (Key && VersionId ? [{ Key, VersionId }] : []));
            const removals = await this.deleteMultipleS3Objects(bucketName, refs);
            yield* removals;
        }
    }

    /**
     * Uploads the given object to a S3 bucket, overriding one if it exists.
     * @param params Attributes for the uploaded object
     */
    public async putObject(params: S3.PutObjectRequest): Promise<S3.PutObjectOutput> {
        return this.s3.putObject(params).promise();
    }

    /**
     * Checks if an object exists at S3 bucket.
     * @param params Attributes for the uploaded object
     */
    public async objectExists({ Bucket, Key }: { Bucket: string; Key: string }): Promise<boolean> {
        try {
            await this.s3.headObject({ Bucket, Key }).promise();
            return true; // Successful -> exists
        } catch (error) {
            if (error.statusCode === 404) {
                return false;
            }
            throw error;
        }
    }

    public async createPresignedPost(options: PresignPostOptions): Promise<S3.PresignedPost> {
        const Conditions = [['content-length-range', 0, options.maxSize]];
        const Fields: { [key: string]: string } = {
            acl: options.access,
            key: options.key,
            success_action_status: String(options.successActionStatus),
        };
        const { contentType } = options;
        if (contentType) {
            const prefixMatch = /^(.+)\/\*$/.exec(contentType);
            if (prefixMatch) {
                Conditions.push(['starts-with', '$Content-Type', prefixMatch[1]]);
            } else {
                Fields['Content-Type'] = contentType;
            }
        }
        Object.keys(options.meta).forEach((key) => {
            Fields[`X-Amz-Meta-${key}`] = options.meta[key];
        });
        const policy = {
            Bucket: options.bucketName,
            Expires: options.expiresIn,
            Conditions,
            Fields,
        };
        return new Promise<S3.PresignedPost>((resolve, reject) => {
            this.s3.createPresignedPost(policy, (error, data) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(data);
                }
            });
        });
    }

    /**
     * Retrieve all the objects from an Amazon S3 bucket.
     */
    private async *iterateObjects(bucketName: string): AsyncIterableIterator<S3.Object> {
        const request = this.s3.listObjectsV2({ Bucket: bucketName });
        for await (const objects of retrievePages(request, 'Contents')) {
            if (objects) {
                yield* objects;
            }
        }
    }

    /**
     * Retrieve all the object versions from an Amazon S3 bucket.
     */
    private async *iterateObjectVersions(bucketName: string): AsyncIterableIterator<S3.ObjectVersion> {
        const request = this.s3.listObjectVersions({ Bucket: bucketName });
        for await (const versions of retrievePages(request, 'Versions')) {
            if (versions) {
                yield* versions;
            }
        }
    }

    /**
     * Deletes an object from a S3 bucket.
     */
    private async deleteMultipleS3Objects(bucketName: string, refs: S3.ObjectIdentifierList) {
        await this.s3
            .deleteObjects({
                Bucket: bucketName,
                Delete: {
                    Objects: refs,
                },
            })
            .promise();
        return refs.map((ref) => ({ ...ref, Bucket: bucketName }));
    }
}
