// tslint:disable:no-shadowed-variable
import { CloudFormation, CloudFront, S3 } from 'aws-sdk';
import { bold, cyan, green, underline, yellow } from 'chalk';
import { map, partition } from 'lodash';
import { difference, fromPairs, groupBy, isArray, mergeWith, sortBy } from 'lodash';
import { capitalize, upperFirst } from 'lodash';
import { Observable } from 'rxjs';
import { URL } from 'url';
import { Stats as WebpackStats } from 'webpack';
import { emptyBucket$ } from './aws';
import { clean$ } from './clean';
import { compile$ } from './compile';
import { IAppConfig } from './config';
import { serve$ } from './server';
import { convertStackParameters, formatS3KeyName, formatStatus, retrievePage$, sendRequest$ } from './utils/aws';
import { isDoesNotExistsError, isUpToDateError } from './utils/aws';
import { readFile$, searchFiles$ } from './utils/fs';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';
import { zip } from './zip';

import * as mime from 'mime';
import * as path from 'path';
import * as File from 'vinyl';
import * as YAML from 'yamljs';

import { IApiEndpoint } from './endpoints';
import { HttpMethod } from './http';

export interface IStackOutput {
    [key: string]: string;
}

export interface IStackWithResources extends CloudFormation.Stack {
    StackResources: CloudFormation.StackResource[];
}

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
     * Deploys the web app, creating/updating the stack
     * and uploading all the files to S3 buckets.
     */
    public deploy$() {
        const frontendCompile$ = this.compileFrontend$();
        const backendCompile$ = this.compileBackend$();
        const ensureStack$ = this.ensureStackExists$();
        const backendUploadPrepare$ = Observable.forkJoin(backendCompile$, ensureStack$);
        const backendUpload$ = backendUploadPrepare$.concat(this.uploadBackend$());
        const deploy$ = backendUpload$.concat(this.deployStack$());
        const frontendUploadPrepare$ = Observable.forkJoin(deploy$, frontendCompile$);
        const frontendUpload$ = frontendUploadPrepare$.concat(this.deployFile$());
        const invalidate$ = this.getStackOutput$().switchMap(
            (output) => this.invalidateCloudFront$(output.SiteCloudFrontDistributionId),
        );
        return this.clean$().concat(frontendUpload$, invalidate$).do({
            complete: () => this.log(`${green('Deployment complete!')} The web app is now available at ${underline(`${this.options.siteOrigin}/`)}`),
        });
    }

    /**
     * Removes (undeploys) the stack, first clearing the contents of the S3 buckets
     */
    public undeploy$(): Observable<CloudFormation.Stack> {
        this.log(`Removing the stack ${bold(this.options.stackName)} from region ${bold(this.options.region)}`);
        return this.getStackOutput$()
            .switchMap((output) => Observable.merge(
                emptyBucket$(this.s3, output.AssetsS3BucketName),
                emptyBucket$(this.s3, output.SiteS3BucketName),
                emptyBucket$(this.s3, output.DeploymentManagementS3BucketName),
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
            .switchMapTo(this.describeStackWithResources$().concat(this.deleteStack$()))
            .scan((oldStack, newStack) => this.logStackChanges(oldStack, newStack))
            .do({
                complete: () => this.log(green('Undeployment complete!')),
            })
        ;
    }

    public compile$(): Observable<WebpackStats> {
        return this.clean$().switchMapTo(
            this.compileBackend$().merge(this.compileFrontend$()),
        );
    }

    /**
     * Compiles the assets with Webpack to the build directory.
     */
    public compileFrontend$(): Observable<WebpackStats> {
        this.log(`Compiling the ${this.options.debug ? yellow('debugging') : cyan('release')} version of the app frontend for the stage ${bold(this.options.stage)}...`);
        return compile$(getFrontendWebpackConfig({...this.options, devServer: false}))
            .do((stats) => this.log(stats.toString({colors: true})))
        ;
    }

    /**
     * Compiles the backend code with Webpack to the build directory.
     */
    public compileBackend$(): Observable<WebpackStats> {
        this.log(`Compiling the ${this.options.debug ? yellow('debugging') : cyan('release')} version of the app backend for the stage ${bold(this.options.stage)}...`);
        return compile$(getBackendWebpackConfig({...this.options, devServer: false}))
            .do((stats) => this.log(stats.toString({colors: true})))
        ;
    }

    /**
     * Runs the local development server.
     */
    public serve$(): Observable<any> {
        this.log(`Starting the local development server...`);
        return serve$(this.options)
            .do((opts) => this.log(`Serving the local development website at ${underline(`${opts.siteOrigin}/`)}`))
        ;
    }

    /**
     * Outputs information about the stack.
     */
    public printStack$(): Observable<IStackWithResources> {
        return this.describeStackWithResources$()
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
        return this.describeStackWithResources$()
            .switchMap((initStack) => this.updateStack$()
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
        return this.getStackOutput$().switchMap((output) =>
            Observable.concat(
                this.uploadFilesToS3Bucket$(output.AssetsS3BucketName, asset$, staticAssetsCacheDuration),
                this.uploadFilesToS3Bucket$(output.SiteS3BucketName, page$, staticHtmlCacheDuration),
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
        return this.getCompiledApiFile$().map((apiFile) => convertStackParameters({
            SiteOrigin: siteOriginUrl.origin,
            SiteDomainName: siteDomain,
            SiteHostedZoneName: getHostedZone(siteDomain),
            AssetsDomainName: assetsDomain,
            AssetsHostedZoneName: getHostedZone(assetsDomain),
            ApiRequestLambdaFunctionS3Key: formatS3KeyName(apiFile.relative, '.zip'),
        }));
    }

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
    public describeStackResources$(): Observable<CloudFormation.StackResource> {
        return retrievePage$(
            this.cloudFormation.describeStackResources({ StackName: this.options.stackName }),
            'StackResources',
        )
        .concatMap((resources) => resources || []);
    }

    /**
     * Like describeStack$ but the stack will also contain the 'StackResources'
     * attribute, containing all the resources of the stack, like from
     * describeStackResources$.
     * @returns Observable for a stack including its resources
     */
    public describeStackWithResources$(): Observable<IStackWithResources> {
        return Observable.combineLatest(
            this.describeStack$(),
            this.describeStackResources$().toArray(),
            (Stack, StackResources) => ({...Stack, StackResources}),
        );
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
                if (isDoesNotExistsError(error)) {
                    return Observable.of(false);
                }
                // Pass the error through
                throw error;
            })
        ;
    }

    /**
     * Creating a new CloudFormation stack using the initialization template.
     * This will fail if the stack already exists.
     * @returns Observable for the starting of stack creation
     */
    public createStack$() {
        return this.readTemplate$(['cloudformation-init.yml'])
            .switchMap((template) => sendRequest$(
                this.cloudFormation.createStack({
                    StackName: this.options.stackName,
                    TemplateBody: dumpTemplate(template),
                    OnFailure: 'ROLLBACK',
                    Capabilities: [
                        'CAPABILITY_IAM',
                        'CAPABILITY_NAMED_IAM',
                    ],
                }),
            ))
            .do(() => this.log('Stack creation has started.'))
            .switchMapTo(this.waitForDeployment$(2000))
        ;
    }

    /**
     * Updating an existing CloudFormation stack using the given template.
     * This will fail if the stack does not exist.
     * NOTE: If no update is needed, the observable completes without emitting any value!
     * @returns Observable for the starting of stack update
     */
    public updateStack$() {
        return Observable.forkJoin(this.generateTemplate$(), this.getStackParameters$())
            .switchMap(([template, parameters]) => sendRequest$(
                this.cloudFormation.updateStack({
                    StackName: this.options.stackName,
                    TemplateBody: dumpTemplate(template),
                    Capabilities: [
                        'CAPABILITY_IAM',
                        'CAPABILITY_NAMED_IAM',
                    ],
                    Parameters: parameters,
                }),
            ).catch((error: Error) => {
                if (isUpToDateError(error)) {
                    // Let's not consider this an error. Just do not emit anything.
                    this.log('Stack is up-to-date! No updates are to be performed.');
                    return Observable.empty() as Observable<CloudFormation.UpdateStackOutput>;
                }
                throw error;
            }))
            .do(() => this.log('Stack update has started.'))
            .switchMapTo(this.waitForDeployment$(2000))
        ;
    }

    /**
     * Deletes the existing CloudFormation stack.
     * This will fail if the stack does not exist.
     */
    public deleteStack$() {
        return sendRequest$(
            this.cloudFormation.deleteStack({ StackName: this.options.stackName }),
        )
        .do(() => this.log('Stack deletion has started.'))
        .switchMapTo(this.waitForDeletion$(2000));
    }

    /**
     * Polls the state of the CloudFormation stack until it changes to
     * a complete state, or fails, in which case the observable fails.
     * @returns Observable emitting the stack and its resources until complete
     */
    public waitForDeployment$(minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStackWithResources$())
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
    public waitForDeletion$(minInterval: number): Observable<IStackWithResources> {
        return new Observable<IStackWithResources>((subscriber) =>
            Observable.timer(0, minInterval)
                .exhaustMap(() => this.describeStackWithResources$())
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
     * Uploads all of the files from the observable to a S3 bucket.
     * @param bucketName Name of the S3 bucket to upload the files
     * @param file$ Observable of vinyl files
     * @param cacheDuration How long the files should be cached
     */
    public uploadFilesToS3Bucket$(bucketName: string, file$: Observable<File>, cacheDuration: number) {
        return file$.mergeMap((file) => this.uploadFileToS3Bucket$(
            bucketName, file, 'public-read', cacheDuration,
        ), 3);
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
        )
        .map((data) => ({file, bucketName, result: data} as IFileUpload))
        .do(() => this.log('Uploaded', bold(file.relative), 'to bucket', bucketName, green('✔︎')));
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
    private uploadBackend$() {
        return this.getCompiledApiFile$()
            .switchMap((file) => {
                return Observable.forkJoin(
                    zip(file.contents, 'api.js'),
                    this.getStackOutput$(),
                )
                .switchMap(([zipFileData, output]) => {
                    const bucketName = output.DeploymentManagementS3BucketName;
                    const key = formatS3KeyName(file.relative, '.zip');
                    this.log(`Zipped the API implementation as ${bold(key)}`);
                    return sendRequest$(
                        this.s3.putObject({
                            Bucket: bucketName,
                            Key: key,
                            Body: zipFileData,
                            ACL: 'private',
                            ContentType: 'application/zip',
                        }),
                    ).do(() => this.log('Uploaded API implementation', bold(key), 'to bucket', bucketName, green('✔︎')));
                });
            })
        ;
    }

    private clean$() {
        return clean$(this.options.buildDir);
    }

    /**
     * Ensures that the CloudFormation stack exists. If it does, this does
     * nothing. If it doesn't, then it an initial stack will be created,
     * containing just the deployment AWS S3 bucket.
     */
    private ensureStackExists$(): Observable<IStackWithResources> {
        return this.checkStackExists$()
            .switchMap((stackExists) => {
                if (stackExists) {
                    return this.describeStackWithResources$();
                } else {
                    this.log(`Creating a new stack...`);
                    return this.createStack$().reduce(
                        (oldStack, newStack) => this.logStackChanges(oldStack, newStack),
                        {} as IStackWithResources,
                    );
                }
            })
        ;
    }

    private generateTemplate$() {
        const apiConfig = this.options.api;
        // TODO: At this point validate that the endpoint configuration looks legit?
        const endpoints = sortBy(
            map(apiConfig && apiConfig.endpoints, ({api, path}, name) => ({api, name, path})),
            ({api}) => api.url,
        );
        const baseTemplates = [
            'cloudformation-init.yml',
            'cloudformation-app.yml',
            'cloudformation-api.yml',
        ];
        // Build templates for API Lambda functions
        const apiFunctions$ = Observable.from(endpoints)
            .concatMap(({name}) => this.readTemplate$(['cloudformation-api-function.yml'], {
                ApiFunctionName: upperFirst(name),
                apiFunctionName: name,
            }))
        ;
        // Build templates for every API Gateway Resource
        const apiResources$ = Observable.from(endpoints)
            .concatMap(({path}) => map(path, (_, index) => path.slice(0, index + 1)))
            .map((path) => ({
                [getApiResourceName(path)]: {
                    Type: 'AWS::ApiGateway::Resource',
                    Properties: {
                        ParentId: path.length > 1 ?
                            {Ref: getApiResourceName(path.slice(0, -1))} :
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
            .concatMap(({api, path, name}) => map(api.methods, (method) => ({method, path, name})))
            .concatMap(({method, path, name}) => this.readTemplate$(['cloudformation-api-method.yml'], {
                ApiMethodName: getApiMethodName(path, method),
                ApiFunctionName: upperFirst(name),
                ApiResourceName: getApiResourceName(path),
                ApiMethod: method,
            }))
        ;
        // Enable CORS for every endpoint URL
        const apiCors$ = Observable.from(endpoints)
            .groupBy(({path}) => path.join('/'), ({api}) => api.methods)
            .mergeMap((methods$) => methods$
                .concatMap((methods) => methods)
                .distinct()
                .toArray()
                .concatMap((methods) => {
                    const path = methods$.key.split('/');
                    return this.readTemplate$(['cloudformation-api-resource-cors.yml'], {
                        ApiMethodName: getApiMethodName(path, 'OPTIONS'),
                        ApiResourceName: getApiResourceName(path),
                        ApiResourceAllowedMethods: methods.join(','),
                    });
                }),
            )
        ;
        return this.readTemplate$(baseTemplates)
            .concat(apiFunctions$)
            .concat(apiResources$)
            .concat(apiMethods$)
            .concat(apiCors$)
            // Merge everything together
            .reduce(mergeTemplates, {} as any)
        ;
    }

    private readTemplate$(templateFiles: string[], placeholders: {[placeholder: string]: string} = {}) {
        return Observable
            .forkJoin(
                map(templateFiles, (templateFile) => readFile$(path.resolve(__dirname, '../res/', templateFile))),
            )
            .concatMap((templates) => map(templates, (template) => deserializeTemplate(template, placeholders)))
            .reduce(mergeTemplates, {} as any)
        ;
    }

    private getCompiledApiFile$() {
        return searchFiles$(this.options.buildDir, ['_api*.js']).single();
    }

    private log(message: any, ...params: any[]) {
        // tslint:disable-next-line:no-console
        console.log(message, ...params);
    }

    private logStackChanges(oldStack: IStackWithResources, newStack: IStackWithResources): IStackWithResources {
        const oldResourceStates = map(oldStack.StackResources, formatResourceChange);
        const newResourceStates = map(newStack.StackResources, formatResourceChange);
        const alteredResourcesStates = difference(newResourceStates, oldResourceStates);
        for (const resourceState of alteredResourcesStates) {
            this.log(resourceState);
        }
        return newStack;
    }
}

function deserializeTemplate(template: string, placeholderValues: {[placeholder: string]: string}) {
    const replacedTemplate = template.replace(/<(\w+)>/g, (match, key) => {
        const value = placeholderValues[key];
        if (value == null) {
            throw new Error(`Missing template placeholder value for ${match}`);
        }
        return value;
    });
    return YAML.parse(replacedTemplate);
}

function dumpTemplate(template: any): string {
    return YAML.stringify(template, 8, 2);
}

function mergeTemplates(template1: any, template2: any): any {
    return mergeWith({}, template1, template2, (objValue, srcValue) => {
        if (isArray(objValue) && isArray(srcValue)) {
            return objValue.concat(srcValue);
        }
    });
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
    if (statusReason) {
        msg += ` (${statusReason})`;
    }
    if (id === 'DomainCertificate' && status === 'CREATE_IN_PROGRESS') {
        msg += `\n${yellow('ACTION REQUIRED!')} You have received the confirmation email(s) from AWS Certificate Manager! ${bold('Please go to your inbox and confirm the certificates using the provided links!')}`;
    }
    return msg;
}

function buildApiResourceHierarchy(endpoints: Array<IApiEndpoint<any>>, parentPath: string[] = []): IApiResourceHierarchy[] {
    const rootResources = groupBy(endpoints, (endpoint) => endpoint.path[0]);
    return map(rootResources, (subEndpoints, pathPart) => {
        const [descendants, children] = partition(subEndpoints, (endpoint) => endpoint.path.length > 1);
        return {
            pathPart,
            parentPath,
            endpoints: children,
            subResources: buildApiResourceHierarchy(map(descendants, (endpoint) => ({
                api: endpoint.api,
                path: endpoint.path.slice(1),
            })), parentPath.concat([pathPart])),
        };
    });
}

interface IApiResourceHierarchy {
    pathPart: string;
    parentPath: string[];
    endpoints: Array<IApiEndpoint<any>>;
    subResources: IApiResourceHierarchy[];
}

function getApiResourceName(urlPath: string[]) {
    return `Url${formatPathForResourceName(urlPath)}ApiGatewayResource`;
}

function getApiMethodName(urlPath: string[], method: HttpMethod) {
    return `Url${formatPathForResourceName(urlPath)}${capitalize(method)}ApiGatewayMethod`;
}

function formatPathForResourceName(urlPath: string[]) {
    return map(urlPath, (path) => {
        const match = /^{(.*)}$/.exec(path);
        return match ? upperFirst(match[1]) : upperFirst(path);
    }).join('');
}
