// tslint:disable:no-shadowed-variable
import { CloudFormation, CloudFront, S3 } from 'aws-sdk';
import { bold, cyan, dim, green, red, underline, yellow } from 'chalk';
import { difference, differenceBy, sortBy } from 'lodash';
import { capitalize, upperFirst } from 'lodash';
import { map } from 'lodash';
import { Observable } from 'rxjs';
import { URL } from 'url';
import { Stats as WebpackStats } from 'webpack';
import { AmazonCloudFormation, IStackWithResources } from './aws/cloudformation';
import { AmazonS3 } from './aws/s3';
import { isDoesNotExistsError } from './aws/utils';
import { formatS3KeyName, formatStatus, sendRequest$ } from './aws/utils';
import { clean$ } from './clean';
import { compile$ } from './compile';
import { IAppConfig } from './config';
import { HttpMethod } from './http';
import { serveBackEnd, serveFrontEnd } from './local';
import { ApiService } from './server';
import { dumpTemplate, mergeTemplates, readTemplate$ } from './templates';
import { searchFiles$ } from './utils/fs';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';
import { zip } from './zip';

import * as mime from 'mime';
import * as path from 'path';
import * as File from 'vinyl';

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

    private cloudFormation = new AmazonCloudFormation(
        this.options.region, this.options.stackName,
    );
    private cloudFront = new CloudFront({
        region: this.options.region,
        apiVersion: '2017-03-25',
    });
    private s3 = new AmazonS3(this.options.region);

    /**
     * Creates a new Broiler utility with the given options.
     * @param options An object of options
     */
    constructor(private options: IAppConfig) { }

    /**
     * Deploys the web app, creating/updating the stack
     * and uploading all the files to S3 buckets.
     */
    public deploy$() {
        const frontendCompile$ = this.compileFrontend$(false);
        const backendCompile$ = this.compileBackend$(false);
        const ensureStack$ = this.initialize$();
        const backendUploadPrepare$ = Observable.forkJoin(backendCompile$, ensureStack$);
        const backendUpload$ = backendUploadPrepare$.concat(this.uploadBackend$());
        const deploy$ = backendUpload$.concat(this.deployStack$());
        const frontendUploadPrepare$ = Observable.forkJoin(deploy$, frontendCompile$);
        const frontendUpload$ = frontendUploadPrepare$.concat(this.deployFile$());
        const invalidate$ = this.cloudFormation.getStackOutput().switchMap(
            (output) => this.invalidateCloudFront$(output.SiteCloudFrontDistributionId),
        );
        return this.clean$().concat(frontendUpload$, invalidate$).do({
            complete: () => this.log(`${green('Deployment complete!')} The web app is now available at ${underline(`${this.options.siteOrigin}/`)}`),
        });
    }

    /**
     * Ensures that the CloudFormation stack exists. If it does, this does
     * nothing. If it doesn't, then it an initial stack will be created,
     * containing just the deployment AWS S3 bucket.
     */
    public initialize$(): Observable<IStackWithResources> {
        return this.cloudFormation.describeStackWithResources()
            .catch((error: Error) => {
                // Check if the message indicates that the stack was not found
                if (isDoesNotExistsError(error)) {
                    this.log(`Creating a new stack...`);
                    return readTemplate$(['cloudformation-init.yml'])
                        .switchMap((template) => this.cloudFormation.createStack(dumpTemplate(template), {}))
                        .reduce(
                            (oldStack, newStack) => this.logStackChanges(oldStack, newStack),
                            {} as IStackWithResources,
                        )
                    ;
                }
                // Pass the error through
                throw error;
            })
        ;
    }

    /**
     * Removes (undeploys) the stack, first clearing the contents of the S3 buckets
     */
    public undeploy$(): Observable<CloudFormation.Stack> {
        this.log(`Removing the stack ${bold(this.options.stackName)} from region ${bold(this.options.region)}`);
        return this.cloudFormation.getStackOutput()
            .switchMap((output) => Observable.merge(
                this.s3.emptyBucket$(output.AssetsS3BucketName),
                this.s3.emptyBucket$(output.SiteS3BucketName),
                this.s3.emptyBucket$(output.DeploymentManagementS3BucketName),
            ))
            .do((item) => {
                if (item.VersionId) {
                    this.log(`Deleted ${bold(item.Key)} version ${bold(item.VersionId)} from bucket ${item.Bucket}`);
                } else {
                    this.log(`Deleted ${bold(item.Key)} from bucket ${item.Bucket}`);
                }
            })
            .count()
            .do((count) => this.log(`Deleted total of ${count} items`))
            .switchMapTo(this.cloudFormation.describeStackWithResources().concat(
                this.cloudFormation.deleteStack(),
            ))
            .scan((oldStack, newStack) => this.logStackChanges(oldStack, newStack))
            .do({
                complete: () => this.log(green('Undeployment complete!')),
            })
        ;
    }

    public compile$(): Observable<WebpackStats> {
        return this.clean$().switchMapTo(
            this.compileBackend$(true).merge(this.compileFrontend$(true)),
        );
    }

    /**
     * Compiles the assets with Webpack to the build directory.
     */
    public compileFrontend$(analyze: boolean): Observable<WebpackStats> {
        this.log(`Compiling the ${this.options.debug ? yellow('debugging') : cyan('release')} version of the app frontend for the stage ${bold(this.options.stage)}...`);
        return compile$(getFrontendWebpackConfig({...this.options, devServer: false, analyze}))
            .do((stats) => this.log(stats.toString({colors: true})))
        ;
    }

    /**
     * Compiles the backend code with Webpack to the build directory.
     */
    public compileBackend$(analyze: boolean): Observable<WebpackStats> {
        if (!this.importApi()) {
            return Observable.empty();
        }
        this.log(`Compiling the ${this.options.debug ? yellow('debugging') : cyan('release')} version of the app backend for the stage ${bold(this.options.stage)}...`);
        return compile$(getBackendWebpackConfig({...this.options, devServer: false, analyze}))
            .do((stats) => this.log(stats.toString({colors: true})))
        ;
    }

    /**
     * Preview the changes that would be deployed.
     */
    public preview$() {
        return this.clean$().concat(
            this.compileBackend$(false),
            Observable.forkJoin(
                this.generateTemplate$(),
                this.getStackParameters$(),
            )
            .switchMap(([template, parameters]) =>
                this.cloudFormation.createChangeSet(dumpTemplate(template), parameters),
            )
            .do((changeSet) => this.logChangeSet(changeSet))
            .mergeMap((changeSet) => this.cloudFormation.deleteChangeSet(changeSet.ChangeSetName as string)),
        );
    }

    /**
     * Runs the local development server.
     */
    public serve$(): Observable<any> {
        this.log(`Starting the local development server...`);
        return serveFrontEnd(this.options)
            .do((opts) => this.log(`Serving the local development website at ${underline(`${opts.siteOrigin}/`)}`))
            .merge(serveBackEnd(this.options))
        ;
    }

    /**
     * Outputs information about the stack.
     */
    public printStack$(): Observable<IStackWithResources> {
        return this.cloudFormation.describeStackWithResources()
            .do((stack) => {
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
                    stack.Outputs.forEach(({OutputKey, OutputValue}) => {
                        this.log(`- ${OutputKey} = ${bold(String(OutputValue))}`);
                    });
                }
            })
        ;
    }

    /**
     * Deploys the CloudFormation stack, assuming that it already exists.
     * If it does not exists, it fails. Polls the stack
     * and its resources while the deployment is in progress.
     */
    public deployStack$(): Observable<IStackWithResources> {
        this.log(`Starting deployment of stack ${bold(this.options.stackName)} to region ${bold(this.options.region)}...`);
        return Observable.forkJoin(
                this.cloudFormation.describeStackWithResources(),
                this.generateTemplate$(),
                this.getStackParameters$(),
            )
            .switchMap(([initStack, template, parameters]) =>
                this.cloudFormation.createChangeSet(dumpTemplate(template), parameters)
                    .switchMap((changeSet) => {
                        this.logChangeSet(changeSet);
                        if (!changeSet.Changes || !changeSet.Changes.length) {
                            return Observable.empty() as Observable<IStackWithResources>;
                        }
                        return this.cloudFormation.executeChangeSet(changeSet.ChangeSetName as string);
                    })
                    .reduce((oldStack, newStack) => this.logStackChanges(oldStack, newStack), initStack),
            )
        ;
    }

    /**
     * Deploys the compiled asset files from the build directory to the
     * Amazon S3 buckets in the deployed stack.
     */
    public deployFile$(): Observable<IFileUpload> {
        const asset$ = searchFiles$(this.options.buildDir, ['!**/*.html', '!_api*.js']);
        const page$ = searchFiles$(this.options.buildDir, ['**/*.html']);
        return this.cloudFormation.getStackOutput().switchMap((output) =>
            Observable.merge(
                this.uploadFilesToS3Bucket$(output.AssetsS3BucketName, asset$, staticAssetsCacheDuration, false),
                this.uploadFilesToS3Bucket$(output.SiteS3BucketName, page$, staticHtmlCacheDuration, true),
            ),
        );
    }

    /**
     * Returns the parameters that are given to the CloudFormation template.
     */
    public getStackParameters$() {
        const siteOriginUrl = new URL(this.options.siteOrigin);
        const siteDomain = siteOriginUrl.hostname;
        const assetsOriginUrl = new URL(this.options.assetsOrigin);
        const assetsDomain = assetsOriginUrl.hostname;
        const apiOriginUrl = new URL(this.options.apiOrigin);
        const apiDomain = apiOriginUrl.hostname;
        return this.getCompiledApiFile$()
            .defaultIfEmpty<File | undefined>(undefined)
            .map((apiFile) => ({
                SiteOrigin: siteOriginUrl.origin,
                SiteDomainName: siteDomain,
                SiteHostedZoneName: getHostedZone(siteDomain),
                AssetsDomainName: assetsDomain,
                AssetsHostedZoneName: getHostedZone(assetsDomain),
                ApiHostedZoneName: getHostedZone(apiDomain),
                ApiDomainName: apiDomain,
                ApiRequestLambdaFunctionS3Key: apiFile && formatS3KeyName(apiFile.relative, '.zip'),
            }))
        ;
    }

    /**
     * Uploads all of the files from the observable to a S3 bucket.
     * @param bucketName Name of the S3 bucket to upload the files
     * @param file$ Observable of vinyl files
     * @param cacheDuration How long the files should be cached
     */
    public uploadFilesToS3Bucket$(bucketName: string, file$: Observable<File>, cacheDuration: number, overwrite: boolean) {
        return file$.mergeMap(
            (file) => this.createS3File$({
                Bucket: bucketName,
                Key: formatS3KeyName(file.relative),
                Body: file.contents as Buffer,
                ACL: 'public-read',
                CacheControl: `max-age=${cacheDuration}`,
                ContentType: mime.lookup(file.relative),
                ContentLength: file.isStream() && file.stat ? file.stat.size : undefined,
            }, overwrite)
            .map((data) => ({file, bucketName, result: data} as IFileUpload)),
            5,
        );
    }

    /**
     * Invalidates items at a CloudFront distribution.
     * @param distributionId CloudFront distribution ID
     * @param items Item patterns to invalidate
     */
    public invalidateCloudFront$(distributionId: string, items = ['/*']) {
        this.log(`Invalidating CloudFront distribution ${distributionId} items`);
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
        ).do(() => this.log(`Successfully created CloudFront distribution invalidation! It should take effect shortly!`));
    }

    /**
     * Deploys the compiled asset files from the build directory to the
     * Amazon S3 buckets in the deployed stack.
     */
    private uploadBackend$(): Observable<S3.PutObjectOutput> {
        if (!this.importApi()) {
            return Observable.empty();
        }
        return this.getCompiledApiFile$()
            .switchMap((file) => {
                return Observable.forkJoin(
                    zip(file.contents, 'api.js'),
                    this.cloudFormation.getStackOutput(),
                )
                .switchMap(([zipFileData, output]) => {
                    const bucketName = output.DeploymentManagementS3BucketName;
                    const key = formatS3KeyName(file.relative, '.zip');
                    this.log(`Zipped the API implementation as ${bold(key)}`);
                    return this.createS3File$({
                        Bucket: bucketName,
                        Key: key,
                        Body: zipFileData,
                        ACL: 'private',
                        ContentType: 'application/zip',
                    }, false);
                });
            })
        ;
    }

    private clean$() {
        return clean$(this.options.buildDir);
    }

    private generateTemplate$() {
        const apiConfig = this.importApi();
        // TODO: At this point validate that the endpoint configuration looks legit?
        const endpoints = sortBy(
            map(apiConfig && apiConfig.apiFunctions, ({endpoint}, name) => ({
                endpoint, name,
                path: endpoint.url.replace(/^\/|\/$/g, '').split('/'),
            })),
            ({endpoint}) => endpoint.url,
        );
        const baseTemplate$ = readTemplate$([
            'cloudformation-init.yml',
            'cloudformation-app.yml',
        ]);
        if (!apiConfig) {
            return baseTemplate$;
        }
        return this.getApiHash$().switchMap((hash) => {
            // Build templates for API Lambda functions
            const apiFunctions$ = Observable.from(endpoints)
                .concatMap(({name}) => readTemplate$(['cloudformation-api-function.yml'], {
                    ApiFunctionName: getApiLambdaFunctionLogicalId(name),
                    apiFunctionName: name,
                }))
            ;
            // Build templates for every API Gateway Resource
            const apiResources$ = Observable.from(endpoints)
                .concatMap(({path}) => map(path, (_, index) => path.slice(0, index + 1)))
                .map((path) => ({
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
                }))
                .reduce((template, resource) => ({...template, ...resource}), {})
                .map((Resources) => ({Resources}))
            ;
            // Build templates for every HTTP method, for every endpoint
            const apiMethods$ = Observable.from(endpoints)
                .concatMap(({endpoint, path, name}) => map(endpoint.methods, (method) => ({method, path, name})))
                .concatMap(({method, path, name}) => readTemplate$(['cloudformation-api-method.yml'], {
                    ApiMethodName: getApiMethodLogicalId(path, method),
                    ApiFunctionName: getApiLambdaFunctionLogicalId(name),
                    ApiResourceName: getApiResourceLogicalId(path),
                    ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
                    ApiMethod: method,
                }))
            ;
            // Enable CORS for every endpoint URL
            const apiCors$ = Observable.from(endpoints)
                .groupBy(({path}) => path.join('/'), ({endpoint}) => endpoint.methods)
                .mergeMap((methods$) => methods$
                    .concatMap((methods) => methods)
                    .distinct()
                    .toArray()
                    .concatMap((methods) => {
                        const path = methods$.key.split('/');
                        return readTemplate$(['cloudformation-api-resource-cors.yml'], {
                            ApiMethodName: getApiMethodLogicalId(path, 'OPTIONS'),
                            ApiResourceName: getApiResourceLogicalId(path),
                            ApiResourceAllowedMethods: methods.join(','),
                            ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
                        });
                    }),
                )
            ;
            return baseTemplate$
                .concat(readTemplate$(['cloudformation-api.yml'], {
                    ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
                }))
                .concat(apiFunctions$)
                .concat(apiResources$)
                .concat(apiMethods$)
                .concat(apiCors$)
                // Merge everything together
                .reduce(mergeTemplates, {} as any)
            ;
        });
    }

    private createS3File$(params: S3.PutObjectRequest, overwrite: boolean) {
        return (overwrite ? Observable.of(false) : this.s3.objectExists$(params))
            .switchMap((fileExists) => {
                if (fileExists) {
                    this.log('File', bold(params.Key), 'already exists in bucket', params.Bucket, green('✔︎'));
                    return [];
                } else {
                    return this.s3.putObject$(params)
                        .do(() => this.log('Uploaded', bold(params.Key), 'to bucket', params.Bucket, green('✔︎')))
                    ;
                }
            })
        ;
    }

    private getCompiledApiFile$() {
        if (this.importApi()) {
            return searchFiles$(this.options.buildDir, ['_api*.js']).single();
        } else {
            return Observable.empty<File>();
        }
    }

    private getApiHash$() {
        return this.getCompiledApiFile$()
            .map((file) => /\.(\w+)\./.exec(file.basename) as RegExpExecArray)
            .map((match) => match[1])
        ;
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
        const oldResourceStates = map(oldStack.StackResources, formatResourceChange);
        const newResourceStates = map(newStack.StackResources, formatResourceChange);
        const deletedResourceStates = map(
            differenceBy(
                oldStack.StackResources,
                newStack.StackResources,
                (resource) => resource.LogicalResourceId,
            ),
            formatResourceDelete,
        );
        const alteredResourcesStates = difference(newResourceStates.concat(deletedResourceStates), oldResourceStates);
        for (const resourceState of alteredResourcesStates) {
            this.log(resourceState);
        }
        return newStack;
    }

    private importApi(): ApiService | null {
        const { apiPath, projectRoot } = this.options;
        if (apiPath) {
            const api = require(path.resolve(projectRoot, apiPath));
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
    return map(urlPath, (path) => {
        const match = /^{(.*)}$/.exec(path);
        return match ? upperFirst(match[1]) : upperFirst(path);
    }).join('');
}
