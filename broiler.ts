// tslint:disable:no-shadowed-variable
import { CloudFormation, CloudFront, S3 } from 'aws-sdk';
import { URL } from 'url';
import { Stats as WebpackStats } from 'webpack';
import { EndpointMethodHandler } from './api';
import { mergeAsync, toArray } from './async';
import { AmazonCloudFormation, IStackWithResources } from './aws/cloudformation';
import { AmazonCloudWatch, formatLogEvent } from './aws/cloudwatch';
import { AmazonRoute53 } from './aws/route53';
import { AmazonS3 } from './aws/s3';
import { formatS3KeyName } from './aws/utils';
import { isDoesNotExistsError } from './aws/utils';
import { clean } from './clean';
import { compile } from './compile';
import { BroilerConfig } from './config';
import { HttpMethod } from './http';
import { AppStageConfig } from './index';
import { serveBackEnd, serveFrontEnd } from './local';
import { readAnswer } from './readline';
import { ApiService } from './server';
import { dumpTemplate, mergeTemplates, readTemplates } from './templates';
import { flatMap, union } from './utils/arrays';
import { difference, differenceBy, order, sort } from './utils/arrays';
import { readFile, readJSONFile, searchFiles, writeJSONFile } from './utils/fs';
import { forEachKey, mapObject, spread, toPairs, values } from './utils/objects';
import { capitalize, upperFirst } from './utils/strings';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';
import { zip } from './zip';

import * as mime from 'mime';
import * as path from 'path';
import * as File from 'vinyl';

import chalk from 'chalk';
import { askParameters } from './parameters';

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
    private readonly route53: AmazonRoute53;
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
        this.route53 = new AmazonRoute53(region);
        this.s3 = new AmazonS3(region);

        this.config = {...config, stackName, stageDir, buildDir};
    }

    /**
     * Deploys the web app, creating/updating the stack
     * and uploading all the files to S3 buckets.
     */
    public async deploy(): Promise<void> {
        await this.clean();
        await this.prepareDeployment();
        await this.deployStack();
        // TODO: Figure out how to make the frontend independent of the stack deployment
        const [output] = await Promise.all([
            this.cloudFormation.getStackOutput(),
            this.compileFrontend(false).then(() => this.uploadFrontend()),
        ]);
        await this.invalidateCloudFront(output.SiteCloudFrontDistributionId);
        this.log(`${green('Deployment complete!')} The web app is now available at ${underline(`${this.config.siteRoot}/`)}`);
    }

    /**
     * Ensures that everything required for the deployment exists.
     *
     * This includes:
     * - An (initial) CloudFormation stack, probably containing just the deployment AWS S3 bucket.
     * - Required hosted zones (which may be shared with other deployments)
     */
    public async initialize() {
        await Promise.all([
            this.initializeHostedZones(),
            this.initializeStack(),
        ]);
    }

    /**
     * Removes (undeploys) the stack, first clearing the contents of the S3 buckets
     */
    public async undeploy(): Promise<CloudFormation.Stack> {
        this.log(`Removing the stack ${bold(this.stackName)} from region ${bold(this.config.region)}`);
        const output = await this.cloudFormation.getStackOutput();
        const {DeploymentManagementS3BucketName, AssetsS3BucketName, SiteS3BucketName} = output;
        // Empty the deployement bucket
        const iterators = [this.s3.emptyBucket(DeploymentManagementS3BucketName)];
        if (AssetsS3BucketName) {
            iterators.push(this.s3.emptyBucket(AssetsS3BucketName));
        }
        if (SiteS3BucketName && SiteS3BucketName !== AssetsS3BucketName) {
            iterators.push(this.s3.emptyBucket(SiteS3BucketName));
        }
        let count = 0;
        for await (const item of mergeAsync(...iterators)) {
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
        const [backend, frontend] = await Promise.all([
            this.compileBackend(true),
            this.compileFrontend(true),
        ]);
        return backend ? [backend, frontend] : [frontend];
    }

    /**
     * Compiles the assets with Webpack to the build directory.
     */
    public async compileFrontend(analyze: boolean): Promise<WebpackStats> {
        this.log(`Compiling the ${this.config.debug ? yellow('debugging') : cyan('release')} version of the app frontend for the stage ${bold(this.config.stage)}...`);
        const output = this.config.auth && await this.cloudFormation.getStackOutput();
        const stats = await compile(getFrontendWebpackConfig({
            ...this.config,
            devServer: false,
            authRoot: output ? output.UserPoolRoot : '<NO AUTH ROOT>',
            authClientId: output ? output.UserPoolClientId : '<NO AUTH CLIENT>',
            analyze,
        }));
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
        const templateUrl = await this.prepareStackTemplate();
        const parameters = await this.getStackParameters();
        const changeSet = await this.cloudFormation.createChangeSet(templateUrl, parameters);
        this.logChangeSet(changeSet);
        await this.cloudFormation.deleteChangeSet(changeSet.ChangeSetName as string);
    }

    /**
     * Runs the local development server.
     */
    public async serve() {
        this.log(`Starting the local development server...`);
        const opts = this.config;
        const paramFile = path.resolve(opts.stageDir, './params.json');
        const prevParams = await readJSONFile(paramFile, {});
        const params = await askParameters(opts.parameters, prevParams);
        try {
            await writeJSONFile(paramFile, params);
        } catch (error) {
            this.log(red(`Failed to write parameters to the JSON file:\n${error}`));
        }
        await Promise.all([
            serveFrontEnd(opts, () => this.log(`Serving the local development website at ${underline(`${opts.siteRoot}/`)}`)),
            serveBackEnd(opts, params),
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
            this.log(formatLogEvent(event, this.stackName));
        }
    }

    /**
     * Ensures that the CloudFormation stack exists. If it does, this does
     * nothing. If it doesn't, then an initial stack will be created,
     * containing just the deployment AWS S3 bucket.
     */
    public async initializeStack(): Promise<IStackWithResources> {
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
     * Ensures that the required hosted zone(s) exist, creating them if not.
     */
    public async initializeHostedZones() {
        const {siteRoot, assetsRoot, apiRoot} = this.config;
        const siteRootUrl = new URL(siteRoot);
        const siteHostedZone = getHostedZone(siteRootUrl.hostname);
        const assetsRootUrl = new URL(assetsRoot);
        const assetsHostedZone = getHostedZone(assetsRootUrl.hostname);
        const apiRootUrl = apiRoot && new URL(apiRoot);
        const apiHostedZone = apiRootUrl && getHostedZone(apiRootUrl.hostname);
        const rawHostedZones = [siteHostedZone, assetsHostedZone, apiHostedZone];
        const hostedZones = union(rawHostedZones.filter((hostedZone) => !!hostedZone) as string[]);
        // Wait until every hosted zone is available
        await Promise.all(hostedZones.map((hostedZone) => this.initializeHostedZone(hostedZone)));
    }

    /**
     * Deploys the CloudFormation stack, assuming that it already exists.
     * If it does not exists, it fails. Polls the stack
     * and its resources while the deployment is in progress.
     */
    public async deployStack(): Promise<IStackWithResources> {
        this.log(`Starting deployment of stack ${bold(this.stackName)} to region ${bold(this.config.region)}...`);
        const templateUrl$ = this.prepareStackTemplate();
        const currentStack$ = await this.cloudFormation.describeStackWithResources();
        const [templateUrl, currentStack] = await Promise.all([templateUrl$, currentStack$]);
        const parameters = await this.getStackParameters();
        const changeSet = await this.cloudFormation.createChangeSet(templateUrl, parameters);
        this.logChangeSet(changeSet);
        let oldStack = currentStack;
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
    public async uploadFrontend(): Promise<IFileUpload[]> {
        const asset$ = searchFiles(this.buildDir, ['!**/*.html', '!_api*.js']);
        const page$ = searchFiles(this.buildDir, ['**/*.html']);
        const res$ = searchFiles(path.join(__dirname, 'res'), ['**/*.html']);
        const output = await this.cloudFormation.getStackOutput();
        const uploadArrays = await Promise.all([
            toArray(this.uploadFilesToS3Bucket(output.AssetsS3BucketName, asset$, staticAssetsCacheDuration, false)),
            toArray(this.uploadFilesToS3Bucket(output.SiteS3BucketName, page$, staticHtmlCacheDuration, true)),
            toArray(this.uploadFilesToS3Bucket(output.SiteS3BucketName, res$, staticHtmlCacheDuration, true)),
        ]);
        return ([] as IFileUpload[]).concat(...uploadArrays);
    }

    /**
     * Returns the parameters that are given to the CloudFormation template.
     */
    public async getStackParameters() {
        const {siteRoot, apiRoot, assetsRoot, auth, defaultPage, parameters} = this.config;
        const siteRootUrl = new URL(siteRoot);
        const siteDomain = siteRootUrl.hostname;
        const assetsRootUrl = new URL(assetsRoot);
        const assetsDomain = assetsRootUrl.hostname;
        const apiRootUrl = apiRoot && new URL(apiRoot);
        const apiDomain = apiRootUrl && apiRootUrl.hostname;
        const apiFile$ = this.getCompiledApiFile();
        const prevParams$ = auth ? this.cloudFormation.getStackParameters() : Promise.resolve(undefined);
        const [apiFile, prevParams] = await Promise.all([apiFile$, prevParams$]);
        // Facebook client settings
        const facebookClientId = auth && auth.facebookClientId || undefined;
        let facebookClientSecret: string | null | undefined = prevParams && prevParams.FacebookClientSecret;
        if (facebookClientId && facebookClientSecret === undefined) {
            facebookClientSecret = await readAnswer(
                `Check your Facebook client app secret at ${underline(`https://developers.facebook.com/apps/${facebookClientId}/settings/basic/`)}\n` +
                `Please enter the client secret:`,
            );
            if (!facebookClientSecret) {
                throw new Error(`Facebook client app secret is required!`);
            }
        }
        // Google client settings
        const googleClientId = auth && auth.googleClientId || undefined;
        let googleClientSecret: string | null | undefined = prevParams && prevParams.GoogleClientSecret;
        if (googleClientId && googleClientSecret === undefined) {
            googleClientSecret = await readAnswer(
                `Check your Google client app secret at ${underline(`https://console.developers.google.com/apis/credentials/oauthclient/${googleClientId}`)}\n` +
                `Please enter the client secret:`,
            );
            if (!googleClientSecret) {
                throw new Error(`Google client app secret is required!`);
            }
        }
        // Ask all the custom parameters
        const customParameters = await askParameters(parameters, prevParams, 'X');
        return {
            SiteRoot: siteRoot,
            SiteOrigin: siteRootUrl.origin,
            SiteDomainName: siteDomain,
            SiteHostedZoneName: getHostedZone(siteDomain),
            SiteDefaultPage: defaultPage != null ? path.resolve('/', defaultPage) : undefined,
            AssetsRoot: assetsRoot,
            AssetsDomainName: assetsDomain,
            AssetsHostedZoneName: getHostedZone(assetsDomain),
            ApiRoot: apiRoot,
            ApiOrigin: apiRootUrl && apiRootUrl.origin,
            ApiHostedZoneName: apiDomain && getHostedZone(apiDomain),
            ApiDomainName: apiDomain,
            ApiRequestLambdaFunctionS3Key: apiFile && formatS3KeyName(apiFile.relative, '.zip'),
            // These parameters are only defined if 'auth' is enabled
            FacebookClientId: facebookClientId,
            FacebookClientSecret: facebookClientSecret,
            GoogleClientId: googleClientId,
            GoogleClientSecret: googleClientSecret,
            // Additional custom parameters (start with 'X')
            ...customParameters,
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
        // TODO: This does not handle well rejections or errors! Improve!
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
     * Ensures that everything required for a deployment is uploaded to the initial stack.
     * If the initial stack is not created, it will be created.
     */
    private async prepareDeployment(): Promise<void> {
        const init$ = this.initialize();
        const backendCompile$ = this.compileBackend(false);
        const customResourceUpload$ = init$.then(() => this.uploadCustomResource());
        const backendUpload$ = Promise.all([init$, backendCompile$]).then(() => this.uploadBackend());
        await Promise.all([customResourceUpload$, backendUpload$]);
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
        const [bucketName, templateFile] = await Promise.all([bucketName$, templateFile$]);
        const templateUpload$ = this.createS3File$({
            Bucket: bucketName,
            Key: templateFileName,
            Body: templateFile,
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
        const output$ = this.cloudFormation.getStackOutput();
        const [output, zipFileData] = await Promise.all([output$, zipFileData$]);
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
    }

    /**
     * Creates the hosted zone if does not exist.
     * @param domain Hosted zone domain name
     */
    private async initializeHostedZone(domain: string) {
        try {
            const {DelegationSet} = await this.route53.getHostedZone(domain);
            this.log(dim(`Hosted zone for domain ${bold(domain)} exists`), green('✔︎'));
            if (this.config.debug && DelegationSet) {
                this.log(`Set up your domain name registrar (e.g. GoDaddy) to use these DNS servers:\n`);
                for (const nameServer of DelegationSet.NameServers) {
                    this.log(`    ${nameServer}`);
                }
            }
        } catch (error) {
            if (!isDoesNotExistsError(error)) {
                // Unknown error -> fail!
                throw error;
            }
            // Hosted zone does not exist yet -> create it!
            this.log(`Hosted zone for domain ${bold(domain)} does not exist yet. Creating it...`);
            const {DelegationSet} = await this.route53.createHostedZone(domain);
            this.log(`Hosted zone ${bold(domain)} created successfully!`, green('✔︎'));
            if (DelegationSet) {
                this.log(`Set up your domain name registrar (e.g. GoDaddy) to use these DNS servers:\n`);
                for (const nameServer of DelegationSet.NameServers) {
                    this.log(`    ${cyan(nameServer)}`);
                }
            }
        }
    }

    private clean(): Promise<string[]> {
        return clean(this.buildDir);
    }

    private async generateTemplate(): Promise<any> {
        const server = this.importServer();
        // TODO: At this point validate that the endpoint configuration looks legit?
        const templateFiles = ['cloudformation-init.yml', 'cloudformation-app.yml'];
        const {auth, defaultPage, parameters} = this.config;
        if (defaultPage) {
            // Enable fallback page for single-page apps using HTML5 History API
            templateFiles.push('cloudformation-spa.yml');
        }
        if (auth) {
            // User registry enabled
            templateFiles.push('cloudformation-user-registry.yml');
            if (auth.facebookClientId) {
                // Enable Facebook login
                templateFiles.push('cloudformation-facebook-login.yml');
            }
            if (auth.googleClientId) {
                // Enable Google login
                templateFiles.push('cloudformation-google-login.yml');
            }
        }
        const template$ = readTemplates(templateFiles);
        if (!server) {
            return await template$;
        }
        const templates = await Promise.all([
            template$,
            this.generateApiTemplate(server),
            this.generateDbTemplates(server),
        ]);
        if (parameters) {
            forEachKey(parameters, (paramName, paramConfig) => {
                templates.unshift({
                    Parameters: {
                        [`X${paramName}`]: {
                            Type: 'String',
                            Description: paramConfig.description,
                        },
                    },
                    Resources: {
                        ApiGatewayStage: {
                            Properties: {
                                Variables: {
                                    [paramName]: {
                                        Ref: `X${paramName}`,
                                    },
                                },
                            },
                        },
                    },
                });
            });
        }
        return templates.reduce(mergeTemplates);
    }

    private async generateApiTemplate(server: ApiService): Promise<any> {
        const endpoints = sort(
            mapObject(server && server.implementations || {}, ({endpoint}, name) => ({
                endpoint, name,
                path: endpoint.route.pattern.pattern.replace(/^\/|\/$/g, '').split('/'),
            })),
            ({endpoint}) => endpoint.route.pattern.pattern,
        );
        const hash = await this.getApiHash();
        if (!hash) {
            // No API to be deployed
            return;
        }
        // Collect all the template promises to an array
        const templatePromises: Array<Promise<any>> = [];
        // Build templates for API Lambda functions
        templatePromises.push(...endpoints.map(({name}) => readTemplates(['cloudformation-api-function.yml'], {
            ApiFunctionName: getApiLambdaFunctionLogicalId(name),
            apiFunctionName: name,
        })));
        // Build templates for every API Gateway Resource
        const nestedApiResources = flatMap(endpoints, ({path}) => path.map((_, index) => path.slice(0, index + 1)));
        templatePromises.push(Promise.resolve({
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
        }));
        // Build templates for every HTTP method, for every endpoint
        const apiMethods = flatMap(
            endpoints, ({endpoint, path, name}) => mapObject(
                endpoint.methodHandlers,
                ({auth}: EndpointMethodHandler, method: HttpMethod) => ({method, path, name, auth}),
            ),
        );
        templatePromises.push(...apiMethods.filter(({auth, name, path, method}) => {
            // Either ignore or fail if the user registry is not enabled but the endpoint requires one
            const config = this.config;
            if (config.auth || auth === 'none') {
                return true;
            } else if (config.debug) {
                this.log(yellow(`${bold('WARNING!')} The endpoint ${name} (${method} /${path.join('/')}) is not deployed because no user registry for authentication is configured!`));
                return false;
            }
            throw new Error(`The endpoint ${name} (${method} /${path.join('/')}) requires user registry configured in the 'auth' property of your configuration!`);
        }).map(
            ({method, path, name, auth}) => readTemplates(['cloudformation-api-method.yml'], {
                ApiMethodName: getApiMethodLogicalId(path, method),
                ApiFunctionName: getApiLambdaFunctionLogicalId(name),
                ApiResourceName: getApiResourceLogicalId(path),
                ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
                ApiMethod: method,
                AuthorizationType: auth === 'none' ? '"NONE"' : '"COGNITO_USER_POOLS"',
                AuthorizerId: JSON.stringify(auth === 'none' ? '' : {Ref: 'ApiGatewayUserPoolAuthorizer'}),
            })),
        );
        // Enable CORS for every endpoint URL
        templatePromises.push(...endpoints.map(({path, endpoint: {methods}}) => {
            return readTemplates(['cloudformation-api-resource-cors.yml'], {
                ApiMethodName: getApiMethodLogicalId(path, 'OPTIONS'),
                ApiResourceName: getApiResourceLogicalId(path),
                ApiResourceAllowedMethods: methods.join(','),
                ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
            });
        }));
        // Read the base template for the API Gateway
        templatePromises.push(readTemplates(['cloudformation-api.yml'], {
            ApiGatewayDeploymentName: `ApiGatewayDeployment${hash.toUpperCase()}`,
        }));
        // Merge everything together
        const templates = await Promise.all(templatePromises);
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

    /**
     * Uploads a CloudFormation template for the stack as an YAML file stored
     * to the S3 deployment bucket.
     */
    private async prepareStackTemplate(): Promise<string> {
        const templateFileName = `cloudformation-template-${this.stackName}.yml`;
        const template$ = this.generateTemplate();
        const stackOutput$ = this.cloudFormation.getStackOutput();
        const [stackOutput, template] = await Promise.all([stackOutput$, template$]);
        const bucketName = stackOutput.DeploymentManagementS3BucketName;
        const bucketDomain = stackOutput.DeploymentManagementS3BucketDomain;
        const templateUpload$ = this.createS3File$({
            Bucket: bucketName,
            Key: templateFileName,
            Body: dumpTemplate(template),
            ContentType: 'application/x-yaml',
        }, true);
        await templateUpload$;
        return `http://${bucketDomain}/${templateFileName}`;
    }

    private async getCompiledApiFile(): Promise<File | undefined> {
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
        const oldStackResources = oldStack.StackResources || [];
        const newStackResources = newStack.StackResources || [];
        const oldResourceStates = oldStackResources.map(formatResourceChange);
        const newResourceStates = newStackResources.map(formatResourceChange);
        const deletedResourceStates = differenceBy(
            oldStackResources,
            newStackResources,
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
        // We replace each '{xxxx}' with just 'ID', otherwise
        // different "placeholders" would cause errors.
        const component = match ? 'ID' : path;
        // Convert from snake_case to CamelCase
        return component.replace(/(?:^|[\W_]+)(\w)/g, (_, letter) => letter.toUpperCase());
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
