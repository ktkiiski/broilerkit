import { S3 } from 'aws-sdk';
import { Observable } from 'rxjs';
import { retrievePage$, sendRequest$ } from './utils/aws';

export interface IDeletedObject {
    Bucket: string;
    Key: string;
    VersionId?: string;
}

/**
 * Retrieve all the objects from an Amazon S3 bucket.
 */
function iterateObject$(s3: S3, bucketName: string): Observable<S3.Object> {
    return retrievePage$(s3.listObjectsV2({ Bucket: bucketName }), 'Contents')
        .concatMap((objects) => objects || [])
    ;
}

/**
 * Retrieve all the object versions from an Amazon S3 bucket.
 */
function iterateObjectVersions$(s3: S3, bucketName: string): Observable<S3.ObjectVersion> {
    return retrievePage$(s3.listObjectVersions({ Bucket: bucketName }), 'Versions')
        .concatMap((versions) => versions || [])
    ;
}

/**
 * Deletes an object from a S3 bucket.
 */
function deleteMultipleS3Object$(s3: S3, bucketName: string, refs: S3.ObjectIdentifierList): Observable<IDeletedObject> {
    return sendRequest$(s3.deleteObjects({
        Bucket: bucketName,
        Delete: {
            Objects: refs,
        },
    }))
    .switchMapTo(refs.map((ref) => ({...ref, Bucket: bucketName})));
}

/**
 * Removes all the items from an Amazon S3 bucket so that it can be deleted.
 */
export function emptyBucket$(s3: S3, bucketName: string): Observable<IDeletedObject> {
    return Observable.concat(
        // Delete regular objects (with null versions)
        iterateObject$(s3, bucketName)
            .concatMap(({Key}) => Key ? [{Key}] : [])
            .bufferCount(100)
            .concatMap((refs) => deleteMultipleS3Object$(s3, bucketName, refs)),
        // Delete all object versions
        iterateObjectVersions$(s3, bucketName)
            .concatMap(({Key, VersionId}) => Key && VersionId ? [{Key, VersionId}] : [])
            .bufferCount(100)
            .concatMap((refs) => deleteMultipleS3Object$(s3, bucketName, refs)),
    );
}
