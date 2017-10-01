import { CloudFormation } from 'aws-sdk';
import { Observable } from 'rxjs';
import { retrievePage$, sendRequest$, convertStackParameters } from './utils';
import fromPairs = require('lodash/fromPairs');
import map = require('lodash/map');

export interface IStackWithResources extends CloudFormation.Stack {
    StackResources: CloudFormation.StackResource[];
}

export interface IStackOutput {
    [key: string]: string;
}

/**
 * Wrapper class for Amazon S3 operations with a reactive interface.
 */
export class AmazonCloudFormation {

    private cloudFormation = new CloudFormation({
        region: this.region,
        apiVersion: '2010-05-15',
    });

    constructor(private region: string, private stackName: string) { }

    /**
     * Describes the CloudFormation stack, or fails if does not exist.
     * @returns Observable for the stack description
     */
    public describeStack(): Observable<CloudFormation.Stack> {
        return sendRequest$(
            this.cloudFormation.describeStacks({ StackName: this.stackName }),
        ).map((stack) => (stack.Stacks || [])[0]);
    }

    /**
     * Describes all the resources in the CloudFormation stack.
     * @returns Observable for a list of stack resources
     */
    public describeStackResources(): Observable<CloudFormation.StackResource> {
        return retrievePage$(
            this.cloudFormation.describeStackResources({ StackName: this.stackName }),
            'StackResources',
        )
        .concatMap((resources) => resources || []);
    }

    /**
     * Like describeStack but the stack will also contain the 'StackResources'
     * attribute, containing all the resources of the stack, like from
     * describeStackResources.
     * @returns Observable for a stack including its resources
     */
    public describeStackWithResources(): Observable<IStackWithResources> {
        return Observable.combineLatest(
            this.describeStack(),
            this.describeStackResources().toArray(),
            (Stack, StackResources) => ({...Stack, StackResources}),
        );
    }

    /**
     * Retrieves the outputs of the CloudFormation stack.
     * The outputs are represented as an object, where keys are the
     * output keys, and values are the output values.
     * @returns Observable for the stack output object
     */
    public getStackOutput(): Observable<IStackOutput> {
        return this.describeStack()
            .map((stack) => fromPairs(map(
                stack.Outputs,
                ({OutputKey, OutputValue}) => [OutputKey, OutputValue]),
            ))
        ;
    }

    /**
     * Creates a CloudFormation stack with the given template
     * This will fail if the stack already exists.
     * @param template CloudFormation stack template string as JSON/YAML
     * @param parameters Template parameters as a key-value object mapping
     */
    public createStack(template: string, parameters: {[name: string]: string}, pollInterval = 2000) {
        const request = {
            StackName: this.stackName,
            TemplateBody: template,
            OnFailure: 'ROLLBACK',
            Parameters: convertStackParameters(parameters),
            Capabilities: [
                'CAPABILITY_IAM',
                'CAPABILITY_NAMED_IAM',
            ],
        };
        return sendRequest$(this.cloudFormation.createStack(request))
            .switchMapTo(this.waitForDeployment(pollInterval))
        ;
    }

    /**
     * Deletes the existing CloudFormation stack.
     * This will fail if the stack does not exist.
     */
    public deleteStack(pollInterval = 2000) {
        return sendRequest$(this.cloudFormation.deleteStack({ StackName: this.stackName }))
            .switchMapTo(this.waitForDeletion(pollInterval));
    }

    /**
     * Creates a stack change set, without deploying the changes.
     * An unique name is automatically generated for the change set.
     *
     * @param template CloudFormation stack template string as JSON/YAML
     * @param parameters Template parameters as a key-value object mapping
     */
    public createChangeSet(template: string, parameters: {[name: string]: any}, pollInterval = 2000): Observable<CloudFormation.DescribeChangeSetOutput> {
        const date = new Date();
        const StackName = this.stackName;
        const ChangeSetName = `${StackName}${date.valueOf()}`;
        const request = {
            ChangeSetName,
            ChangeSetType: 'UPDATE',
            StackName,
            TemplateBody: template,
            Capabilities: [
                'CAPABILITY_IAM',
                'CAPABILITY_NAMED_IAM',
            ],
            Parameters: convertStackParameters(parameters),
        };
        const describeChangeSetInput = {ChangeSetName, StackName};
        // Start creating the change set
        return sendRequest$(this.cloudFormation.createChangeSet(request))
        .switchMapTo(sendRequest$(this.cloudFormation.describeChangeSet(describeChangeSetInput)))
            // Wait until the change set is created
            .switchMapTo(this.waitForChangeSetCreateComplete(describeChangeSetInput, pollInterval))
        ;
    }

    /**
     * Executes the change set of the given name.
     * Emits state of the stack with interval. The last emitted state
     * just before the completion will describe the completely updated stack.
     * @param ChangeSetName Name of the change set.
     */
    public executeChangeSet(ChangeSetName: string, pollInterval = 2000): Observable<IStackWithResources> {
        const request = {ChangeSetName, StackName: this.stackName};
        return sendRequest$(this.cloudFormation.executeChangeSet(request))
            .switchMapTo(this.waitForDeployment(pollInterval))
        ;
    }

    /**
     * Deletes a stack change set of the given name.
     * @param ChangeSetName Name of the change set.
     */
    public deleteChangeSet(ChangeSetName: string) {
        const request = {ChangeSetName, StackName: this.stackName};
        return sendRequest$(this.cloudFormation.deleteChangeSet(request))
            .map((response) => ({...request, ...response}))
        ;
    }

    /**
     * Polls the state of the CloudFormation stack until it changes to
     * a complete state, or fails, in which case the observable fails.
     * @returns Observable emitting the stack and its resources until complete
     */
    private waitForDeployment(minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStackWithResources())
                .subscribe((stack) => {
                    const stackStatus = stack.StackStatus;
                    if (/_IN_PROGRESS$/.test(stackStatus)) {
                        subscriber.next(stack);
                    } else if (/_FAILED$|ROLLBACK_COMPLETE$/.test(stackStatus)) {
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
     * Polls the state of the CloudFormation stack until the stack no longer exists.
     * @returns Observable emitting the stack and its resources until deleted
     */
    private waitForDeletion(minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStackWithResources())
                .subscribe((stack) => {
                    const stackStatus = stack.StackStatus;
                    if (stackStatus.endsWith('_IN_PROGRESS')) {
                        subscriber.next(stack);
                    } else if (stackStatus.endsWith('_FAILED')) {
                        subscriber.next(stack);
                        subscriber.error(new Error(`Stack deployment failed: ${stack.StackStatusReason}`));
                    }
                }, () => {
                    // Error occurred: assume that the stack does not exist!
                    subscriber.complete();
                }),
        );
    }

    /**
     * Waits until a change set is completely created, emitting the final state.
     * Fails if the creation fails.
     */
    private waitForChangeSetCreateComplete(request: CloudFormation.DescribeChangeSetInput, pollInterval: number): Observable<CloudFormation.DescribeChangeSetOutput> {
        return Observable.timer(0, pollInterval)
            .exhaustMap(() => sendRequest$(this.cloudFormation.describeChangeSet(request)))
            // Get all the changes in the change set
            .switchMap((changeSet) =>
                retrievePage$(this.cloudFormation.describeChangeSet(request), 'Changes')
                    .concatMap((changes) => changes || [])
                    .toArray()
                    .map((Changes) => ({...changeSet, Changes}))
            )
            .first(({Status}) => Status && Status.endsWith('_COMPLETE') || Status == 'FAILED')
            .map((changeSet) => {
                // Check if the change set creation has actually failed
                // NOTE: If the change set would not result in changes, then this is NOT considered a failure
                const { Status, StatusReason } = changeSet;
                if (Status === 'FAILED' && (!StatusReason || StatusReason.indexOf(`submitted information didn't contain changes`) < 0)) {
                    throw new Error(`Failed to create a change set: ${StatusReason}`);
                }
                return changeSet;
            })
        ;
    }
}
