import { CloudFormation, CloudFront, S3 } from 'aws-sdk';
import { fromPairs, map } from 'lodash';
import { Observable } from 'rxjs';
import { src, SrcOptions } from 'vinyl-fs';

import * as mime from 'mime';
import * as path from 'path';
import * as File from 'vinyl';

export interface IStackOutput {
    [key: string]: string;
}

export interface IBroilerOptions {
    region: string;
}

export interface IStackWithResources extends CloudFormation.Stack {
    StackResources: CloudFormation.StackResource[];
}

export class Broiler {

    private cloudFormation = new CloudFormation({
        region: this.options.region,
        apiVersion: '2010-05-15',
    });
    private cloudFront = new CloudFront({
        region: this.options.region,
        apiVersion: '2017-03-25',
    });
    private s3 = new S3({
        region: this.options.region,
        apiVersion: '2006-03-01',
    });

    /**
     * Creates a new Broiler utility with the given options.
     * @param options An object of options
     */
    constructor(private options: IBroilerOptions) { }

    /**
     * Describes a CloudFormation stack, or fails if does not exist.
     * @param stackName Name of the CloudFormation stack
     * @returns Observable for the stack description
     */
    public describeStack$(stackName: string): Observable<CloudFormation.Stack> {
        return sendRequest$(
            this.cloudFormation.describeStacks({ StackName: stackName }),
        ).map((stack) => (stack.Stacks || [])[0]);
    }

    /**
     * Describes all the resources in the given CloudFormation stack.
     * @param stackName Name of the CloudFormation stack
     * @returns Observable for a list of stack resources
     */
    public describeStackResources$(stackName: string): Observable<CloudFormation.StackResource[]> {
        return sendRequest$(
            this.cloudFormation.describeStackResources({ StackName: stackName }),
        ).map((data) => data.StackResources || []);
    }

    /**
     * Retrieves the outputs of the given CloudFormation stack.
     * The outputs are represented as an object, where keys are the
     * output keys, and values are the output values.
     * @param stackName Name of the CloudFormation stack
     * @returns Observable for the stack output object
     */
    public getStackOutput$(stackName: string): Observable<IStackOutput> {
        return this.describeStack$(stackName)
            .map((stack) => fromPairs(map(
                stack.Outputs,
                ({OutputKey, OutputValue}) => [OutputKey, OutputValue]),
            ))
        ;
    }

    /**
     * Checks whether or not a CloudFormation stack with the given name
     * exists, resulting to a boolean value.
     * @param stackName Name of the CloudFormation stack to check
     * @returns Observable for a boolean value
     */
    public checkStackExists$(stackName: string): Observable<boolean> {
        return this.describeStack$(stackName)
            .mapTo(true)
            .catch<boolean, boolean>((error: Error) => {
                // Check if the message indicates that the stack was not found
                if (error.message && error.message.indexOf('does not exist') >= 0) {
                    return Observable.of(false);
                }
                // Pass the error through
                return Observable.throw(error);
            })
        ;
    }

    /**
     * Starts creating a new CloudFormation stack using the given template.
     * This will fail if the stack already exists.
     * @param stackName Name of the CloudFormation stack
     * @param template CloudFormation template as a string
     * @param parameters Object of key-value pairs of the parameters
     * @returns Observable for the starting of stack creation
     */
    public startCreateStack$(stackName: string, template: string, parameters: object): Observable<CloudFormation.CreateStackOutput> {
        return sendRequest$(
            this.cloudFormation.createStack({
                StackName: stackName,
                TemplateBody: template,
                OnFailure: 'ROLLBACK',
                Capabilities: [
                    'CAPABILITY_IAM',
                    'CAPABILITY_NAMED_IAM',
                ],
                Parameters: convertStackParameters(parameters),
            }),
        );
    }

    /**
     * Starts updating an existing CloudFormation stack using the given template.
     * This will fail if the stack does not exist.
     * NOTE: If no update is needed, the observable completes without emitting any value!
     * @param stackName Name of the CloudFormation stack
     * @param template CloudFormation template as a string
     * @param parameters Object of key-value pairs of the parameters
     * @returns Observable for the starting of stack update
     */
    public startUpdateStack$(stackName: string, template: string, parameters: object) {
        return sendRequest$(
            this.cloudFormation.updateStack({
                StackName: stackName,
                TemplateBody: template,
                Capabilities: [
                    'CAPABILITY_IAM',
                    'CAPABILITY_NAMED_IAM',
                ],
                Parameters: convertStackParameters(parameters),
            }),
        ).catch<CloudFormation.UpdateStackOutput, CloudFormation.UpdateStackOutput>((error: Error) => {
            if (error.message && error.message.indexOf('No updates are to be performed') >= 0) {
                // Let's not consider this an error. Just do not emit anything.
                return Observable.empty();
            }
            return Observable.throw(error);
        });
    }

    /**
     * Deploys the given CloudFormation stack. If the stack already exists,
     * it will be updated. Otherwise, it will be created. Polls the stack
     * and its resources while the deployment is in progress.
     * @param stackName Name of the CloudFormation stack
     * @param parameters Parameters for the CloudFormation template
     * @param template CloudFromation template string for the creation/update
     */
    public deployStack$(stackName: string, parameters: object, template: string): Observable<IStackWithResources>;
    /**
     * Deploys the given CloudFormation stack. If the stack already exists,
     * it will be updated. Otherwise, it will be created. Polls the stack
     * and its resources while the deployment is in progress.
     * @param stackName Name of the CloudFormation stack
     * @param parameters Parameters for the CloudFormation template
     * @param updateTemplate CloudFromation template string for the update
     * @param createTemplate CloudFromation template string for the creation
     */
    public deployStack$(stackName: string, parameters: object, updateTemplate: string, createTemplate = updateTemplate): Observable<IStackWithResources> {
        return this.checkStackExists$(stackName).first()
            // Either create or update the stack
            .switchMap((stackExists) => stackExists
                ? this.startUpdateStack$(stackName, updateTemplate, parameters)
                : this.startCreateStack$(stackName, createTemplate, parameters),
            )
            // Start polling the stack state after creation/update has started successfully
            .defaultIfEmpty(null)
            .switchMapTo(this.waitForDeployment$(stackName, 2000))
        ;
    }
    /**
     * Polls the state of the given CloudFormation stack until it changes to
     * a complete state, or fails, in which case the observable fails.
     * @param stackName Name of the CloudFormation stack
     * @returns Observable emitting the stack and its resources until complete
     */
    public waitForDeployment$(stackName: string, minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStack$(stackName)
                    .combineLatest(
                        this.describeStackResources$(stackName),
                        (Stack, StackResources) => ({...Stack, StackResources}) as IStackWithResources,
                    )
                    .first(),
                )
                .subscribe((stack) => {
                    const stackStatus = stack.StackStatus;
                    if (stackStatus.endsWith('_IN_PROGRESS')) {
                        subscriber.next(stack);
                    } else if (stackStatus.endsWith('_FAILED')) {
                        subscriber.next(stack);
                        subscriber.error(new Error(`Stack deployment failed: ${stack.StackStatusReason}`));
                    } else {
                        subscriber.next(stack);
                        subscriber.complete();
                    }
                }),
        );
    }

    /**
     * Uploads the given Vinyl file to a Amazon S3 bucket.
     * @param bucketName Name of the S3 bucket to upload the files
     * @param file The Vinyl file to upload
     * @param acl The ACL parameter used for the object PUT operation
     * @param cacheDuration Number of seconds for caching the files
     */
    public uploadFileToS3Bucket$(bucketName: string, file: File, acl: S3.ObjectCannedACL, cacheDuration: number) {
        return sendRequest$(
            this.s3.putObject({
                Bucket: bucketName,
                Key: formatS3KeyName(file.relative),
                Body: file.contents as Buffer,
                ACL: acl,
                CacheControl: `max-age=${cacheDuration}`,
                ContentType: mime.lookup(file.relative),
                ContentLength: file.isStream() && file.stat ? file.stat.size : undefined,
            }),
        );
    }

    /**
     * Invalidates items at a CloudFront distribution.
     * @param distributionId CloudFront distribution ID
     * @param items Item patterns to invalidate
     */
    public invalidateCloudFront$(distributionId: string, items = ['/*']) {
        return sendRequest$(
            this.cloudFront.createInvalidation({
                DistributionId: distributionId,
                InvalidationBatch: { /* required */
                    CallerReference: new Date().toISOString(),
                    Paths: {
                        Quantity: items.length,
                        Items: items,
                    },
                },
            }),
        );
    }
}

/**
 * Converts an object of parameter key-values to an
 * array of stack parameter objects.
 * @param parameters An object of parameter key-values
 * @returns Array of parameter objects.
 */
function convertStackParameters(parameters: {[key: string]: any}) {
    return map(
        parameters,
        (ParameterValue, ParameterKey) => ({ParameterKey, ParameterValue}),
    );
}

/**
 * Creates an observable that emits all files matching the given
 * file patterns as vinyl files.
 * @param globs an array of glob patterns
 * @returns observable for matching vinyl-files
 */
export function src$(globs: string[], opts?: SrcOptions): Observable<File> {
    return new Observable((subscriber) => {
        const stream = src(globs, opts);
        stream.on('end', () => subscriber.complete());
        stream.on('error', (error) => subscriber.error(error));
        stream.on('data', (file) => subscriber.next(file));
    });
}

/**
 * Converts a AWS.Request instance to an Observable.
 */
function sendRequest$<D, E>(request: AWS.Request<D, E>): Observable<D> {
    return new Observable<D>((subscriber) => {
        request.send((error, data) => {
            if (error) {
                subscriber.error(error);
            } else {
                subscriber.next(data);
                subscriber.complete();
            }
        });
    });
}

function formatS3KeyName(filename: string): string {
    const extension = path.extname(filename);
    const dirname = path.dirname(filename);
    const basename = path.basename(filename, extension);
    return path.join(dirname, `${basename}${extension}`);
}
