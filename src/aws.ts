import { AWSError, S3 } from 'aws-sdk';
import { Observable } from 'rxjs';
import { retrievePage$, sendRequest$ } from './utils/aws';

/**
 * Wrapper class for Amazon S3 operations with a reactive interface.
 */
export class AmazonS3 {

    private s3 = new S3({
        region: this.region,
        apiVersion: '2006-03-01',
    });

    constructor(private region: string) { }

    /**
     * Removes all the items from an Amazon S3 bucket so that it can be deleted.
     */
    public emptyBucket$(bucketName: string) {
        return Observable.concat(
            // Delete regular objects (with null versions)
            this.iterateObject$(bucketName)
                .concatMap(({Key}) => Key ? [{Key}] : [])
                .bufferCount(100)
                .concatMap((refs) => this.deleteMultipleS3Object$(bucketName, refs)),
            // Delete all object versions
            this.iterateObjectVersions$(bucketName)
                .concatMap(({Key, VersionId}) => Key && VersionId ? [{Key, VersionId}] : [])
                .bufferCount(100)
                .concatMap((refs) => this.deleteMultipleS3Object$(bucketName, refs)),
        );
    }

    /**
     * Uploads the given object to a S3 bucket, overriding one if it exists.
     * @param params Attributes for the uploaded object
     */
    public putObject$(params: S3.PutObjectRequest) {
        return sendRequest$(this.s3.putObject(params));
    }

    /**
     * Checks if an object exists at S3 bucket.
     * @param params Attributes for the uploaded object
     */
    public objectExists$({Bucket, Key}: {Bucket: string, Key: string}): Observable<boolean> {
        return sendRequest$(this.s3.headObject({Bucket, Key}))
            .mapTo(true)
            .catch((error: AWSError) => {
                if (error.statusCode === 404) {
                    return [false];
                }
                throw error;
            })
        ;
    }

    /**
     * Retrieve all the objects from an Amazon S3 bucket.
     */
    private iterateObject$(bucketName: string): Observable<S3.Object> {
        return retrievePage$(this.s3.listObjectsV2({ Bucket: bucketName }), 'Contents')
            .concatMap((objects) => objects || [])
        ;
    }

    /**
     * Retrieve all the object versions from an Amazon S3 bucket.
     */
    private iterateObjectVersions$(bucketName: string): Observable<S3.ObjectVersion> {
        return retrievePage$(this.s3.listObjectVersions({ Bucket: bucketName }), 'Versions')
            .concatMap((versions) => versions || [])
        ;
    }

    /**
     * Deletes an object from a S3 bucket.
     */
    private deleteMultipleS3Object$(bucketName: string, refs: S3.ObjectIdentifierList) {
        return sendRequest$(this.s3.deleteObjects({
            Bucket: bucketName,
            Delete: {
                Objects: refs,
            },
        }))
        .switchMapTo(refs.map((ref) => ({...ref, Bucket: bucketName})));
    }
}
