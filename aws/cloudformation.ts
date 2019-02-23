import { CloudFormation } from 'aws-sdk';
import { wait } from '../async';
import { buildObject, mapObject } from '../utils/objects';
import { retrievePages } from './utils';

export interface IStackWithResources extends CloudFormation.Stack {
    StackResources: CloudFormation.StackResource[];
}

export interface IStackOutput {
    [key: string]: string;
}

export type StackParameterValue = string | null | undefined;

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
     * @returns Promise for the stack description
     */
    public async describeStack(): Promise<CloudFormation.Stack> {
        const {Stacks} = await this.cloudFormation.describeStacks({ StackName: this.stackName }).promise();
        if (Stacks && Stacks.length) {
            return Stacks[0];
        }
        throw new Error(`Stack was not found`);
    }

    /**
     * Describes all the resources in the CloudFormation stack.
     * @returns Async iterator for each stack resource
     */
    public async describeStackResources(): Promise<CloudFormation.StackResource[]> {
        const stackResources: CloudFormation.StackResource[] = [];
        const request = this.cloudFormation.describeStackResources({ StackName: this.stackName });
        for await (const page of retrievePages(request, 'StackResources')) {
            if (page) {
                stackResources.push(...page);
            }
        }
        return stackResources;
    }

    /**
     * Like describeStack but the stack will also contain the 'StackResources'
     * attribute, containing all the resources of the stack, like from
     * describeStackResources.
     * @returns Promise for a stack including its resources
     */
    public async describeStackWithResources(): Promise<IStackWithResources> {
        return {
            ...await this.describeStack(),
            StackResources: await this.describeStackResources(),
        };
    }

    /**
     * Retrieves the outputs of the CloudFormation stack.
     * The outputs are represented as an object, where keys are the
     * output keys, and values are the output values.
     * @returns Promise for the stack output object
     */
    public async getStackOutput(): Promise<IStackOutput> {
        const stack = await this.describeStack();
        return buildObject(stack.Outputs || [], ({OutputKey, OutputValue}) => {
            if (OutputKey && OutputValue) {
                return [OutputKey, OutputValue];
            }
        });
    }

    /**
     * Retrieves the original parameters of the CloudFormation stack.
     */
    public async getStackParameters(): Promise<{[key: string]: string | null}> {
        const stack = await this.describeStack();
        return buildObject(stack.Parameters || [], ({ParameterKey, ParameterValue, UsePreviousValue}) => {
            if (ParameterKey) {
                if (UsePreviousValue) {
                    return [ParameterKey, null];
                } else if (ParameterValue != null) {
                    return [ParameterKey, ParameterValue];
                }
            }
        });
    }

    /**
     * Creates a CloudFormation stack with the given template
     * This will fail if the stack already exists.
     * @param template CloudFormation stack template string as JSON/YAML
     * @param parameters Template parameters as a key-value object mapping
     */
    public async *createStack(template: string, parameters: {[name: string]: string}, pollInterval = 2000): AsyncIterableIterator<IStackWithResources> {
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
        await this.cloudFormation.createStack(request).promise();
        yield *this.waitForDeployment(pollInterval);
    }

    /**
     * Deletes the existing CloudFormation stack.
     * This will fail if the stack does not exist.
     */
    public async *deleteStack(pollInterval = 2000) {
        await this.cloudFormation.deleteStack({ StackName: this.stackName }).promise();
        yield *this.waitForDeletion(pollInterval);
    }

    /**
     * Creates a stack change set, without deploying the changes.
     * An unique name is automatically generated for the change set.
     *
     * @param template CloudFormation stack template string as JSON/YAML
     * @param parameters Template parameters as a key-value object mapping
     */
    public async createChangeSet(templateUrl: string, parameters: {[name: string]: StackParameterValue}, pollInterval = 2000): Promise<CloudFormation.DescribeChangeSetOutput> {
        const date = new Date();
        const StackName = this.stackName;
        const ChangeSetName = `${StackName}${date.valueOf()}`;
        const request = {
            ChangeSetName,
            ChangeSetType: 'UPDATE',
            StackName,
            TemplateURL: templateUrl,
            Capabilities: [
                'CAPABILITY_IAM',
                'CAPABILITY_NAMED_IAM',
            ],
            Parameters: convertStackParameters(parameters),
        };
        const describeChangeSetInput = {ChangeSetName, StackName};
        // Start creating the change set
        await this.cloudFormation.createChangeSet(request).promise();
        await this.cloudFormation.describeChangeSet(describeChangeSetInput).promise();
        // Wait until the change set is created
        return await this.waitForChangeSetCreateComplete(describeChangeSetInput, pollInterval);
    }

    /**
     * Executes the change set of the given name.
     * Emits state of the stack with interval. The last emitted state
     * just before the completion will describe the completely updated stack.
     * @param ChangeSetName Name of the change set.
     */
    public async *executeChangeSet(ChangeSetName: string, pollInterval = 2000): AsyncIterableIterator<IStackWithResources> {
        await this.cloudFormation.executeChangeSet({ChangeSetName, StackName: this.stackName}).promise();
        yield *this.waitForDeployment(pollInterval);
    }

    /**
     * Deletes a stack change set of the given name.
     * @param ChangeSetName Name of the change set.
     */
    public async deleteChangeSet(ChangeSetName: string): Promise<CloudFormation.DeleteChangeSetInput & CloudFormation.DeleteChangeSetOutput> {
        const request = {ChangeSetName, StackName: this.stackName};
        const {$response, ...response} = await this.cloudFormation.deleteChangeSet(request).promise();
        return {...request, ...response};
    }

    /**
     * Polls the state of the CloudFormation stack until it changes to
     * a complete state, or fails, in which case the observable fails.
     * @returns Observable emitting the stack and its resources until complete
     */
    private async *waitForDeployment(interval: number): AsyncIterableIterator<IStackWithResources> {
        while (true) {
            const stack = await this.describeStackWithResources();
            const stackStatus = stack.StackStatus;
            if (/_IN_PROGRESS$/.test(stackStatus)) {
                yield stack;
            } else if (/_FAILED$|ROLLBACK_COMPLETE$/.test(stackStatus)) {
                yield stack;
                throw new Error(`Stack deployment failed: ${stack.StackStatusReason}`);
            } else {
                yield stack;
                break;
            }
            await wait(interval);
        }
    }

    /**
     * Polls the state of the CloudFormation stack until the stack no longer exists.
     * @returns Observable emitting the stack and its resources until deleted
     */
    private async *waitForDeletion(interval: number): AsyncIterableIterator<IStackWithResources> {
        while (true) {
            let stack;
            try {
                stack = await this.describeStackWithResources();
            } catch {
                // Error occurred: assume that the stack does not exist!
                return;
            }
            const stackStatus = stack.StackStatus;
            if (stackStatus.endsWith('_IN_PROGRESS')) {
                yield stack;
            } else if (stackStatus.endsWith('_FAILED')) {
                yield stack;
                throw new Error(`Stack deletion failed: ${stack.StackStatusReason}`);
            }
            await wait(interval);
        }
    }

    /**
     * Waits until a change set is completely created, emitting the final state.
     * Fails if the creation fails.
     */
    private async waitForChangeSetCreateComplete(request: CloudFormation.DescribeChangeSetInput, pollInterval: number): Promise<CloudFormation.DescribeChangeSetOutput> {
        while (true) {
            const changeSet = await this.cloudFormation.describeChangeSet(request).promise();
            const changeSetReq = this.cloudFormation.describeChangeSet(request);
            // Get all the changes in the change set
            const Changes = [];
            for await (const changes of retrievePages(changeSetReq, 'Changes')) {
                if (changes) {
                    Changes.push(...changes);
                }
            }
            const fullChangeSet = {...changeSet, Changes};
            const { Status, StatusReason } = fullChangeSet;
            if (Status && Status.endsWith('_COMPLETE') || Status === 'FAILED') {
                // Check if the change set creation has actually failed
                // NOTE: If the change set would not result in changes, then this is NOT considered a failure
                if (Status === 'FAILED' && (!StatusReason || StatusReason.indexOf(`submitted information didn't contain changes`) < 0)) {
                    throw new Error(`Failed to create a change set: ${StatusReason}`);
                }
                return changeSet;
            }
            await wait(pollInterval);
        }
    }
}

/**
 * Converts an object of parameter key-values to an
 * array of stack parameter objects.
 * @param parameters An object of parameter key-values
 * @returns Array of parameter objects.
 */
export function convertStackParameters(parameters: {[key: string]: StackParameterValue}) {
    return mapObject(parameters, (ParameterValue, ParameterKey) => {
        if (ParameterValue === null) {
            return {ParameterKey, UsePreviousValue: true};
        } else {
            return {ParameterKey, ParameterValue};
        }
    }).filter(({UsePreviousValue, ParameterValue}) => UsePreviousValue || ParameterValue !== undefined);
}
