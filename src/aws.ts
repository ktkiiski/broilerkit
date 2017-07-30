import { CloudFormation, CloudFront, S3 } from 'aws-sdk';
import { fromPairs, map } from 'lodash';
import { Observable } from 'rxjs';
import { IAppConfig } from './config';
import { readFile$ } from './utils';

import * as mime from 'mime';
import * as path from 'path';
import * as File from 'vinyl';

export interface IStackOutput {
    [key: string]: string;
}

export interface IStackWithResources extends CloudFormation.Stack {
    StackResources: CloudFormation.StackResource[];
}

export class AWS {

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
    constructor(private options: IAppConfig) { }

    /**
     * Describes the CloudFormation stack, or fails if does not exist.
     * @returns Observable for the stack description
     */
    public describeStack$(): Observable<CloudFormation.Stack> {
        return sendRequest$(
            this.cloudFormation.describeStacks({ StackName: this.options.stackName }),
        ).map((stack) => (stack.Stacks || [])[0]);
    }

    /**
     * Describes all the resources in the CloudFormation stack.
     * @returns Observable for a list of stack resources
     */
    public describeStackResources$(): Observable<CloudFormation.StackResource[]> {
        return sendRequest$(
            this.cloudFormation.describeStackResources({ StackName: this.options.stackName }),
        ).map((data) => data.StackResources || []);
    }

    /**
     * Retrieves the outputs of the CloudFormation stack.
     * The outputs are represented as an object, where keys are the
     * output keys, and values are the output values.
     * @returns Observable for the stack output object
     */
    public getStackOutput$(): Observable<IStackOutput> {
        return this.describeStack$()
            .map((stack) => fromPairs(map(
                stack.Outputs,
                ({OutputKey, OutputValue}) => [OutputKey, OutputValue]),
            ))
        ;
    }

    /**
     * Checks whether or not the CloudFormation stack exists,
     * resulting to a boolean value.
     * @returns Observable for a boolean value
     */
    public checkStackExists$(): Observable<boolean> {
        return this.describeStack$()
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
     * Starts creating a new CloudFormation stack using the template.
     * This will fail if the stack already exists.
     * @param parameters Object of key-value pairs of the parameters
     * @returns Observable for the starting of stack creation
     */
    public startCreateStack$(parameters: object): Observable<CloudFormation.CreateStackOutput> {
        return this.readTemplate$()
            .switchMap((template) => sendRequest$(
                this.cloudFormation.createStack({
                    StackName: this.options.stackName,
                    TemplateBody: template,
                    OnFailure: 'ROLLBACK',
                    Capabilities: [
                        'CAPABILITY_IAM',
                        'CAPABILITY_NAMED_IAM',
                    ],
                    Parameters: convertStackParameters(parameters),
                }),
            ))
        ;
    }

    /**
     * Starts updating an existing CloudFormation stack using the given template.
     * This will fail if the stack does not exist.
     * NOTE: If no update is needed, the observable completes without emitting any value!
     * @param parameters Object of key-value pairs of the parameters
     * @returns Observable for the starting of stack update
     */
    public startUpdateStack$(parameters: object) {
        return this.readTemplate$()
            .switchMap((template) => sendRequest$(
                this.cloudFormation.updateStack({
                    StackName: this.options.stackName,
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
            }))
        ;
    }

    /**
     * Deploys the CloudFormation stack. If the stack already exists,
     * it will be updated. Otherwise, it will be created. Polls the stack
     * and its resources while the deployment is in progress.
     * @param parameters Parameters for the CloudFormation template
     */
    public deployStack$(parameters: object): Observable<IStackWithResources> {
        return this.checkStackExists$().first()
            // Either create or update the stack
            .switchMap((stackExists) => stackExists
                ? this.startUpdateStack$(parameters)
                : this.startCreateStack$(parameters),
            )
            // Start polling the stack state after creation/update has started successfully
            .defaultIfEmpty(null)
            .switchMapTo(this.waitForDeployment$(2000))
        ;
    }
    /**
     * Polls the state of the CloudFormation stack until it changes to
     * a complete state, or fails, in which case the observable fails.
     * @returns Observable emitting the stack and its resources until complete
     */
    public waitForDeployment$(minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStack$()
                    .combineLatest(
                        this.describeStackResources$(),
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

    private readTemplate$() {
        return readFile$(this.options.templatePath);
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
