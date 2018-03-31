// tslint:disable:no-shadowed-variable
import { CloudFormation, CloudFront, S3 } from 'aws-sdk';
import { URL } from 'url';
import { Stats as WebpackStats } from 'webpack';
import { mergeAsync, toArray } from './async';
import { AmazonCloudFormation, IStackWithResources } from './aws/cloudformation';
import { AmazonCloudWatch } from './aws/cloudwatch';
import { AmazonS3 } from './aws/s3';
import { isDoesNotExistsError } from './aws/utils';
import { formatS3KeyName } from './aws/utils';
import { clean } from './clean';
import { compile } from './compile';
import { BroilerConfig } from './config';
import { HttpMethod } from './http';
import { AppStageConfig } from './index';
import { serveBackEnd, serveFrontEnd } from './local';
import { ApiService } from './server';
import { dumpTemplate, mergeTemplates, readTemplates } from './templates';
import { difference, differenceBy, order, sort } from './utils/arrays';
import { flatMap } from './utils/arrays';
import { readFile, searchFiles } from './utils/fs';
import { mapObject, spread, toPairs, values } from './utils/objects';
import { capitalize, upperFirst } from './utils/strings';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';
import { zip } from './zip';

import * as mime from 'mime';
import * as path from 'path';
import * as File from 'vinyl';

import chalk from 'chalk';

const { red, bold, green, underline, yellow, cyan, dim } = chalk;

export interface IFileUpload {
    file: File;
    bucketName: string;
    result: S3.PutObjectOutput;
}

// Static assets are cached for a year
const staticAssetsCacheDuration = 31556926;
// HTML pages are cached for an hour
const staticHtmlCacheDuration = 3600;

export class Broiler {

    private readonly config: BroilerConfig;
    // The name of the stack to be deployed
    private readonly stackName: string;
    // The full path to the directory for the current stage
    private readonly stageDir: string;
    // The full path to the build directory inside the stage directory
    private readonly buildDir: string;

    private readonly cloudFormation: AmazonCloudFormation;
    private readonly cloudFront: CloudFront;
    private readonly cloudWatch: AmazonCloudWatch;
    private readonly s3: AmazonS3;

    /**
     * Creates a new Broiler utility with the given options.
     * @param options An object of options
     */
    constructor(config: AppStageConfig) {
        const {name, stage, projectRootPath, region} = config;
        const stackName = this.stackName = `${name}-${stage}`;
        const stageDir = this.stageDir = path.join(projectRootPath, '.broiler', stage || 'local');
        const buildDir = this.buildDir = path.join(stageDir, 'build');

        this.cloudFormation = new AmazonCloudFormation(region, stackName);
        this.cloudFront = new CloudFront({region, apiVersion: '2017-03-25'});
        this.cloudWatch = new AmazonCloudWatch(region);
        this.s3 = new AmazonS3(region);

        this.config = {...config, stackName, stageDir, buildDir};
    }

    /**
     * Deploys the web app, creating/updating the stack
     * and uploading all the files to S3 buckets.
     */
    public async deploy(): Promise<void> {
        await this.clean();
        const frontendCompile$ = this.compileFrontend(false);
        const backendCompile$ = this.compileBackend(false);
        await this.initialize();
        const customResourceUpload$ = this.uploadCustomResource();
        await backendCompile$;
        await this.uploadBackend();
        await customResourceUpload$;
        await this.deployStack();
        const stackOutput$ = this.cloudFormation.getStackOutput();
        await frontendCompile$;
        await this.deployFile();
        const output = await stackOutput$;
        await this.invalidateCloudFront(output.SiteCloudFrontDistributionId);
        this.log(`${green('Deployment complete!')} The web app is now available at ${underline(`${this.config.siteRoot}/`)}`);
    }

    /**
     * Ensures that the CloudFormation stack exists. If it does, this does
     * nothing. If it doesn't, then it an initial stack will be created,
     * containing just the deployment AWS S3 bucket.
     */
    public async initialize(): Promise<IStackWithResources> {
        try {
            return await this.cloudFormation.describeStackWithResources();
        } catch (error) {
            // Check if the message indicates that the stack was not found
            if (!isDoesNotExistsError(error)) {
                // Pass the error through
                throw error;
            }
        }
        this.log(`Creating a new stack...`);
        const template = await readTemplates(['cloudformation-init.yml']);
        let oldStack = {} as IStackWithResources;
        for await (const newStack of this.cloudFormation.createStack(dumpTemplate(template), {})) {
            this.logStackChanges(oldStack, newStack);
            oldStack = newStack;
        }
        return oldStack;
    }

    /**
     * Removes (undeploys) the stack, first clearing the contents of the S3 buckets
     */
    public async undeploy(): Promise<CloudFormation.Stack> {
        this.log(`Removing the stack ${bold(this.stackName)} from region ${bold(this.config.region)}`);
        const output = await this.cloudFormation.getStackOutput();
        const emptyAssets$ = this.s3.emptyBucket(output.AssetsS3BucketName);
        const emptySite$ = this.s3.emptyBucket(output.SiteS3BucketName);
        const emptyDeployment$ = this.s3.emptyBucket(output.DeploymentManagementS3BucketName);
        let count = 0;
        for await (const item of mergeAsync(emptyAssets$, emptySite$, emptyDeployment$)) {
            if (item.VersionId) {
                this.log(`Deleted ${bold(item.Key)} version ${bold(item.VersionId)} from bucket ${item.Bucket}`);
            } else {
                this.log(`Deleted ${bold(item.Key)} from bucket ${item.Bucket}`);
            }
            count ++;
        }
        this.log(`Deleted total of ${count} items`);
        let oldStack = await this.cloudFormation.describeStackWithResources();
        for await (const newStack of this.cloudFormation.deleteStack()) {
            this.logStackChanges(oldStack, newStack);
            oldStack = newStack;
        }
        this.log(green('Undeployment complete!'));
        return oldStack;
    }

    public async compile(): Promise<WebpackStats[]> {
        await this.clean();
        const backend$ = this.compileBackend(true);
        const frontend$ = this.compileFrontend(true);
        const backend = await backend$;
        const frontend = await frontend$;
        return backend ? [backend, frontend] : [frontend];
    }

    /**
     * Compiles the assets with Webpack to the build directory.
     */
    public async compileFrontend(analyze: boolean): Promise<WebpackStats> {
        this.log(`Compiling the ${this.config.debug ? yellow('debugging') : cyan('release')} version of the app frontend for the stage ${bold(this.config.stage)}...`);
        const stats = await compile(getFrontendWebpackConfig({...this.config, devServer: false, analyze}));
        this.log(stats.toString({colors: true}));
        return stats;
    }

    /**
     * Compiles the backend code with Webpack to the build directory.
     */
    public async compileBackend(analyze: boolean): Promise<WebpackStats | void> {
        if (this.importServer()) {
            this.log(`Compiling the ${this.config.debug ? yellow('debugging') : cyan('release')} version of the app backend for the stage ${bold(this.config.stage)}...`);
            const stats = await compile(getBackendWebpackConfig({...this.config, devServer: false, analyze}));
            this.log(stats.toString({colors: true}));
            return stats;
        }
    }

    /**
     * Preview the changes that would be deployed.
     */
    public async preview() {
        await this.clean();
        await this.compileBackend(false);
        const template$ = this.generateTemplate();
        const parameters$ = this.getStackParameters();
        const changeSet = await this.cloudFormation.createChangeSet(dumpTemplate(await template$), await parameters$);
        this.logChangeSet(changeSet);
        await this.cloudFormation.deleteChangeSet(changeSet.ChangeSetName as string);
    }

    /**
     * Runs the local development server.
     */
    public async serve() {
        this.log(`Starting the local development server...`);
        const opts = this.config;
        await Promise.all([
            serveFrontEnd(opts, () => this.log(`Serving the local development website at ${underline(`${opts.siteRoot}/`)}`)),
            serveBackEnd(opts),
        ]);
    }

    /**
     * Outputs information about the stack.
     */
    public printStack(): Promise<IStackWithResources> {
        return this.cloudFormation.describeStackWithResources().then((stack) => {
            this.log(`Stack ${bold(stack.StackName)}`);
            this.log(`- Status: ${formatStatus(stack.StackStatus)}`);
            this.log('Resources:');
            for (const resource of stack.StackResources) {
                const status = resource.ResourceStatus;
                const colorizedStatus = formatStatus(status);
                const statusReason = resource.ResourceStatusReason;
                let msg = `- ${bold(resource.LogicalResourceId)}: ${colorizedStatus}`;
                if (statusReason) {
                    msg += ` (${statusReason})`;
                }
                this.log(msg);
            }
            if (stack.Outputs) {
                this.log('Outputs:');
                order(stack.Outputs, 'OutputKey', 'asc').forEach(({OutputKey, OutputValue}) => {
                    this.log(`- ${OutputKey} = ${bold(String(OutputValue))}`);
                });
            }
            return stack;
        });
    }

    /**
     * Outputs the logs
     */
    public async printLogs(options: {follow?: boolean, since?: string, maxCount?: number} = {}) {
        const {follow = false, since = '5min', maxCount} = options;
        const startDate = new Date();
        const minutesMatch = /(\d+)min/.exec(since);
        if (minutesMatch) {
            startDate.setMinutes(startDate.getMinutes() - parseInt(minutesMatch[1], 10));
        }
        const hoursMatch = /(\d+)h/.exec(since);
        if (hoursMatch) {
            startDate.setHours(startDate.getHours() - parseInt(hoursMatch[1], 10));
        }
        const daysMatch = /(\d+)d/.exec(since);
        if (daysMatch) {
            startDate.setDate(startDate.getDate() - parseInt(daysMatch[1], 10));
        }
        const output = await this.cloudFormation.getStackOutput();
        const logGroupNames = toPairs(output)
            .filter(([key]) => key.endsWith('LogGroupName'))
            .map(([, logGroupName]) => logGroupName)
        ;
        const logStream = this.cloudWatch.streamLogGroups({
            follow, maxCount, logGroupNames, startTime: +startDate,
        });
        for await (const event of logStream) {
            const timestamp = new Date(event.timestamp).toISOString();
            const groupName = event.logGroupName.replace(/^\/aws\/lambda\//, '');
            const message = event.message.trim();
            this.log(`${dim(`${timestamp}:`)} ${cyan(groupName)} ${message}`);
        }
    }

    /**
     * Deploys the CloudFormation stack, assuming that it already exists.
     * If it does not exists, it fails. Polls the stack
     * and its resources while the deployment is in progress.
     */
    public async deployStack(): Promise<IStackWithResources> {
        this.log(`Starting deployment of stack ${bold(this.stackName)} to region ${bold(this.config.region)}...`);
        const template$ = this.generateTemplate();
        const parameters$ = this.getStackParameters();
        let oldStack = await this.cloudFormation.describeStackWithResources();
        const changeSet = await this.cloudFormation.createChangeSet(dumpTemplate(await template$), await parameters$);
        this.logChangeSet(changeSet);
        if (changeSet.Changes && changeSet.Changes.length) {
            const execution$ = this.cloudFormation.executeChangeSet(changeSet.ChangeSetName as string);
            for await (const newStack of execution$) {
                this.logStackChanges(oldStack, newStack);
                oldStack = newStack;
            }
        }
        return oldStack;
    }

    /**
     * Deploys the compiled asset files from the build directory to the
     * Amazon S3 buckets in the deployed stack.
     */
    public async deployFile(): Promise<IFileUpload[]> {
        const asset$ = searchFiles(this.buildDir, ['!**/*.html', '!_api*.js']);
        const page$ = searchFiles(this.buildDir, ['**/*.html']);
        const output = await this.cloudFormation.getStackOutput();
        const assetUpload$ = this.uploadFilesToS3Bucket(output.AssetsS3BucketName, asset$, staticAssetsCacheDuration, false);
        const pageUpload$ = this.uploadFilesToS3Bucket(output.SiteS3BucketName, page$, staticHtmlCacheDuration, true);
        return [...await toArray(assetUpload$), ...await toArray(pageUpload$)];
    }

    /**
     * Returns the parameters that are given to the CloudFormation template.
     */
    public async getStackParameters() {
        const {siteRoot, apiRoot, assetsRoot} = this.config;
        const siteRootUrl = new URL(siteRoot);
        const siteDomain = siteRootUrl.hostname;
        const assetsRootUrl = new URL(assetsRoot);
        const assetsDomain = assetsRootUrl.hostname;
        const apiRootUrl = apiRoot && new URL(apiRoot);
        const apiDomain = apiRootUrl && apiRootUrl.hostname;
        const apiFile = await this.getCompiledApiFile();
        return {
            SiteRoot: siteRoot,
            SiteOrigin: siteRootUrl.origin,
            SiteDomainName: siteDomain,
            SiteHostedZoneName: getHostedZone(siteDomain),
            AssetsRoot: assetsRoot,
            AssetsDomainName: assetsDomain,
            AssetsHostedZoneName: getHostedZone(assetsDomain),
            ApiRoot: apiRoot,
            ApiOrigin: apiRootUrl && apiRootUrl.origin,
            ApiHostedZoneName: apiDomain && getHostedZone(apiDomain),
            ApiDomainName: apiDomain,
            ApiRequestLambdaFunctionS3Key: apiFile && formatS3KeyName(apiFile.relative, '.zip'),
        };
    }

    /**
     * Uploads all of the files from the observable to a S3 bucket.
     * @param bucketName Name of the S3 bucket to upload the files
     * @param file$ Observable of vinyl files
     * @param cacheDuration How long the files should be cached
     */
    public async *uploadFilesToS3Bucket(bucketName: string, file$: Promise<File[]>, cacheDuration: number, overwrite: boolean) {
        const files = [...await file$];
        const uploads$: Array<Promise<IFileUpload>> = [];
        const startNext = () => {
            const file = files.shift();
            if (!file) { return; }
            const upload$ = this.createS3File$({
                Bucket: bucketName,
                Key: formatS3KeyName(file.relative),
                Body: file.contents as Buffer,
                ACL: 'public-read',
                CacheControl: `max-age=${cacheDuration}`,
                ContentType: mime.getType(file.relative) || undefined,
                ContentLength: file.isStream() && file.stat ? file.stat.size : undefined,
            }, overwrite);
            uploads$.push(upload$.then((result) => {
                startNext();
                return {file, bucketName, result} as IFileUpload;
            }));
        };
        // Start 5 first uploads
        startNext(); startNext(); startNext(); startNext(); startNext();
        // Wait for each upload and yield them in order
        while (uploads$.length) {
            const next = await uploads$.shift();
            if (next) {
                yield next;
            }
        }
    }

    /**
     * Invalidates items at a CloudFront distribution.
     * @param distributionId CloudFront distribution ID
     * @param items Item patterns to invalidate
     */
    public async invalidateCloudFront(distributionId: string, items = ['/*']): Promise<CloudFront.CreateInvalidationResult> {
        this.log(`Invalidating CloudFront distribution ${distributionId} items`);
        const result = await this.cloudFront.createInvalidation({
            DistributionId: distributionId,
            InvalidationBatch: { /* required */
                CallerReference: new Date().toISOString(),
                Paths: {
                    Quantity: items.length,
                    Items: items,
                },
            },
        }).promise();
        this.log(`Successfully created CloudFront distribution invalidation! It should take effect shortly!`);
        return result;
    }

    /**
     * Uploads a CloudFormation template and a Lambda JavaScript source code
     * required for custom CloudFormation resources. Any existing files
     * are overwritten.
     */
    private async uploadCustomResource(): Promise<S3.PutObjectOutput> {
        const templateFileName = 'cloudformation-custom-resource.yml';
        const bucketName$ = this.cloudFormation.getStackOutput().then((output) => output.DeploymentManagementS3BucketName);
        const templateFile$ = readFile(path.join(__dirname, 'res', templateFileName));
        const templateUpload$ = this.createS3File$({
            Bucket: await bucketName$,
            Key: templateFileName,
            Body: await templateFile$,
            ContentType: 'application/x-yaml',
        }, true);
        return (await templateUpload$) as S3.PutObjectOutput;
    }

    /**
     * Deploys the compiled asset files from the build directory to the
     * Amazon S3 buckets in the deployed stack.
     */
    private async uploadBackend(): Promise<S3.PutObjectOutput | void> {
        const file = await this.getCompiledApiFile();
        if (!file) {
            return;
        }
        const zipFileData$ = zip(file.contents, 'api.js');
        const output = await this.cloudFormation.getStackOutput();
        const bucketName = output.DeploymentManagementS3BucketName;
        const key = formatS3KeyName(file.relative, '.zip');
        this.log(`Zipped the API implementation as ${bold(key)}`);
        return this.createS3File$({
            Bucket: bucketName,
            Key: key,
            Body: await zipFileData$,
            ACL: 'private',
            ContentType: 'application/zip',
        }, false);
    }

    private clean(): Promise<string[]> {
        return clean(this.buildDir);
    }

    private async generateTemplate(): Promise<any> {
        const server = this.importServer();
        // TODO: At this point validate that the endpoint configuration looks legit?
        const template$ = readTemplates([
            'cloudformation-init.yml',
            'cloudformation-app.yml',
            'cloudformation-user-registry.yml',
        ]);
        if (!server) {
            return await template$;
        }
        const apiTemplate$ = this.generateApiTemplate(server);
        const dbTemplate$ = this.generateDbTemplates(server);
        return mergeTemplates(mergeTemplates(await template$, await apiTemplate$), await dbTemplate$);
    }

    private async generateApiTemplate(server: ApiService): Promise<any> {
        const endpoints = sort(
            mapObject(server && server.implementations || {}, ({endpoint}, name) => ({
                endpoint, name,
                path: endpoint.pathPattern.replace(/^\/|\/$/g, '').split('/'),
            })),
            ({endpoint}) => endpoint.pathPattern,
        );
        const hash = await this.getApiHash();
        if (!hash) {
            // No API to be deployed
            return;
        }
        // Build templates for API Lambda functions
        const apiFunctions$ = endpoints.map(({name}) => readTemplates(['cloudformation-api-function.yml'], {
            ApiFunctionName: getApiLambdaFunctionLogicalId(name),
            apiFunctionName: name,
        }));
        // Build templates for every API Gateway Resource
        const nestedApiResources = flatMap(endpoints, ({path}) => path.map((_, index) => path.slice(0, index + 1)));
        const apiResources = {
            Resources: nestedApiResources.map((path) => ({
                [getApiResourceLogicalId(path)]: {
                    Type: 'AWS::ApiGateway::Resource',
                    Properties: {
                        ParentId: path.length > 1 ?
                            {Ref: getApiResourceLogicalId(path.slice(0, -1))} :
                            {'Fn::GetAtt': ['ApiGatewayRestApi', 'RootResourceId']},
                        PathPart: path[path.length - 1],
                        RestApiId: {
                            Ref: 'ApiGatewayRestApi',
                        },
                    },
                },
            })).reduce((a, b) => spread(a, b), {}), // Shallow-merge required
        };
        // Build templates for every HTTP method, for every endpoint
        const apiMethods = flatMap(
            endpoints, ({endpoint, path, name}) => endpoint.methods.map((method) => ({method, path, name})),
        );
        const apiMethods$ = apiMethods.map(
            ({method, path, name}) => readTemplates(['cloudformation-api-method.yml'], {
                ApiMethodName: getApiMethodLogicalId(path, method),
                ApiFunctionName: getApiLambdaFunctionLogicalId(name),
                ApiResourceName: getApiResourceLogicalId(path),
                ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
                ApiMethod: method,
            }))
        ;
        // Enable CORS for every endpoint URL
        const corsResources$ = endpoints.map(({path, endpoint: {methods}}) => {
            return readTemplates(['cloudformation-api-resource-cors.yml'], {
                ApiMethodName: getApiMethodLogicalId(path, 'OPTIONS'),
                ApiResourceName: getApiResourceLogicalId(path),
                ApiResourceAllowedMethods: methods.join(','),
                ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
            });
        });
        const templates: any[] = [];
        // Yield the base template for all APIs
        templates.push(await readTemplates(['cloudformation-api.yml'], {
            ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
        }));
        // Yield each API function resource
        for (const apiFunction$ of apiFunctions$) {
            templates.push(await apiFunction$);
        }
        // Yield each API Gateway resource
        templates.push(apiResources);
        // Yield each API method
        for (const apiMethod$ of apiMethods$) {
            templates.push(await apiMethod$);
        }
        // Yield all CORS methods
        for (const cors$ of corsResources$) {
            templates.push(await cors$);
        }
        return templates.reduce(mergeTemplates, {});
    }

    private async generateDbTemplates(service: ApiService): Promise<any> {
        const sortedTables = order(values(service.dbTables), 'name', 'asc');
        return sortedTables.map((table) => {
            const logicalId = `DatabaseTable${upperFirst(table.name)}`;
            const tableUriVar = `${logicalId}URI`;
            const tableUriSub = 'arn:aws:sdb:${AWS::Region}:${AWS::AccountId}:domain/${' + logicalId + '}';
            return {
                AWSTemplateFormatVersion: '2010-09-09',
                // Create the domain for the SimpleDB table
                Resources: {
                    [logicalId]: {
                        Type : 'AWS::SDB::Domain',
                        Properties : {
                            Description: `Database table for "${table.name}"`,
                        },
                    },
                    // Make the domain name available for Lambda functions as a stage variable
                    ApiGatewayStage: {
                        Properties: {
                            Variables: {
                                [tableUriVar]: {
                                    'Fn::Sub': tableUriSub,
                                },
                            },
                        },
                    },
                },
                // Output the name for the created SimpleDB domain
                Outputs: {
                    [tableUriVar]: {
                        Value: {
                            'Fn::Sub': tableUriSub,
                        },
                    },
                },
            };
        }).reduce(mergeTemplates, {});
    }

    private async createS3File$(params: S3.PutObjectRequest, overwrite: boolean): Promise<S3.PutObjectOutput | void> {
        if (!overwrite && await this.s3.objectExists(params)) {
            this.log('File', bold(params.Key), 'already exists in bucket', params.Bucket, green('✔︎'));
        } else {
            const result = await this.s3.putObject(params);
            this.log('Uploaded', bold(params.Key), 'to bucket', params.Bucket, green('✔︎'));
            return result;
        }
    }

    private async getCompiledApiFile(): Promise<File | void> {
        if (this.importServer()) {
            const files = await searchFiles(this.buildDir, ['_api*.js']);
            if (files.length !== 1) {
                throw new Error(`Couldn't find the compiled API bundle!`);
            }
            return files[0];
        }
    }

    private async getApiHash(): Promise<string | void> {
        const file = await this.getCompiledApiFile();
        if (file) {
            const match = /\.(\w+)\./.exec(file.basename) as RegExpExecArray;
            return match[1];
        }
    }

    private log(message: any, ...params: any[]) {
        // tslint:disable-next-line:no-console
        console.log(message, ...params);
    }

    private logChangeSet(changeSet: CloudFormation.DescribeChangeSetOutput) {
        if (!changeSet.Changes || !changeSet.Changes.length) {
            this.log(`Stack is up to date! No changes are to be performed!`);
            return;
        }
        this.log(`Changes to be performed to the stack:`);
        for (const {ResourceChange} of changeSet.Changes) {
            if (ResourceChange) {
                const { Action, LogicalResourceId, Details } = ResourceChange;
                const colorize = Action === 'Add' ? green
                    : Action === 'Modify' ? cyan
                    : red
                ;
                const icon = Action === 'Add' ? '+'
                    : Action === 'Modify' ? '●'
                    : '-'
                ;
                if (Details && Details.length) {
                    for (const { Target, CausingEntity, ChangeSource } of Details) {
                        const cause = CausingEntity || ChangeSource;
                        const suffix = cause ? ` ${dim(`← ${cause}`)}` : '';
                        if (Target) {
                            this.log(`[${colorize(icon)}] ${colorize(LogicalResourceId as string)}.${Target.Attribute}.${Target.Name}${suffix}`);
                        }
                    }
                } else {
                    this.log(`[${colorize(icon)}] ${colorize(LogicalResourceId as string)}`);
                }
            }
        }
    }

    private logStackChanges(oldStack: IStackWithResources, newStack: IStackWithResources): IStackWithResources {
        const oldResourceStates = oldStack.StackResources.map(formatResourceChange);
        const newResourceStates = newStack.StackResources.map(formatResourceChange);
        const deletedResourceStates = differenceBy(
            oldStack.StackResources,
            newStack.StackResources,
            (resource) => resource.LogicalResourceId,
        ).map(formatResourceDelete);
        const alteredResourcesStates = difference(newResourceStates.concat(deletedResourceStates), oldResourceStates);
        for (const resourceState of alteredResourcesStates) {
            this.log(resourceState);
        }
        return newStack;
    }

    private importServer(): ApiService | null {
        const { serverFile, projectRootPath, sourceDir } = this.config;
        if (serverFile) {
            const api = require(path.resolve(projectRootPath, sourceDir, serverFile));
            return api.config || api;
        }
        return null;
    }
}

function getHostedZone(domain: string) {
    const match = /([^.]+\.[^.]+)$/.exec(domain);
    return match && match[0];
}

function formatResourceChange(resource: CloudFormation.StackResource): string {
    const id = resource.LogicalResourceId;
    const status = resource.ResourceStatus;
    const colorizedStatus = formatStatus(status);
    const statusReason = resource.ResourceStatusReason;
    let msg = `Resource ${bold(id)} => ${colorizedStatus}`;
    if (status.endsWith('_FAILED') && statusReason) {
        msg += ` (${statusReason})`;
    }
    if (id === 'DomainCertificate' && status === 'CREATE_IN_PROGRESS') {
        msg += `\n${yellow('ACTION REQUIRED!')} You have received the confirmation email(s) from AWS Certificate Manager! ${bold('Please go to your inbox and confirm the certificates using the provided links!')}`;
    }
    if (/CloudFrontDistribution$/.test(id) && /^(CREATE|UPDATE|DELETE)_IN_PROGRESS$/.test(status)) {
        msg += ` (This will take a while)`;
    }
    return msg;
}

function formatResourceDelete(resource: CloudFormation.StackResource): string {
    return formatResourceChange({
        ...resource,
        ResourceStatus: 'DELETE_COMPLETED',
        ResourceStatusReason: undefined,
    });
}

function getApiLambdaFunctionLogicalId(name: string) {
    return `Api${upperFirst(name)}LambdaFunction`;
}

function getApiResourceLogicalId(urlPath: string[]) {
    return `Endpoint${formatPathForLogicalId(urlPath)}ApiGatewayResource`;
}

function getApiMethodLogicalId(urlPath: string[], method: HttpMethod) {
    return `Endpoint${formatPathForLogicalId(urlPath)}${capitalize(method)}ApiGatewayMethod`;
}

function formatPathForLogicalId(urlPath: string[]) {
    return urlPath.map((path) => {
        const match = /^{(.*)}$/.exec(path);
        return match ? upperFirst(match[1]) : upperFirst(path);
    }).join('');
}

function formatStatus(status: string): string {
    if (status.endsWith('_FAILED')) {
        return red(status);
    } else if (status.endsWith('_COMPLETE')) {
        return green(status);
    } else {
        return cyan(status);
    }
}
