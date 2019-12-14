// tslint:disable:no-shadowed-variable
import { CloudFormation, S3 } from 'aws-sdk';
import chalk from 'chalk';
import * as mime from 'mime';
import * as path from 'path';
import { Client, Pool } from 'pg';
import { URL } from 'url';
import * as File from 'vinyl';
import { Stats as WebpackStats } from 'webpack';
import { mapAsync, mergeAsync, toArray } from './async';
import { AmazonCloudFormation, IStackWithResources } from './aws/cloudformation';
import { AmazonCloudWatch, formatLogEvent } from './aws/cloudwatch';
import { AmazonRoute53 } from './aws/route53';
import { AmazonS3 } from './aws/s3';
import { isDoesNotExistsError } from './aws/utils';
import { formatS3KeyName } from './aws/utils';
import { clean } from './clean';
import { compile } from './compile';
import { BroilerConfig } from './config';
import { create, DatabaseTable, scan, Table, write } from './db';
import { ensureDirectoryExists, readFileBuffer, readJSONFile, readLines, searchFiles, writeAsyncIterable, writeJSONFile } from './fs';
import { HttpStatus, isResponse } from './http';
import { AppStageConfig } from './index';
import { launchLocalDatabase, openLocalDatabasePsql, serveBackEnd, serveFrontEnd } from './local';
import { createTable } from './migration';
import { OAUTH2_SIGNOUT_ENDPOINT_NAME, OAuth2SignOutController } from './oauth';
import { OAUTH2_SIGNIN_ENDPOINT_NAME, OAuth2SignInController } from './oauth';
import { OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME, OAuth2SignedInController } from './oauth';
import { OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME, OAuth2SignedOutController } from './oauth';
import { askParameters } from './parameters';
import { Database, DatabaseClient, PostgreSqlConnection, RemotePostgreSqlConnection, SqlConnection } from './postgres';
import { readAnswer } from './readline';
import { retryWithBackoff } from './retry';
import { ApiService } from './server';
import { RENDER_WEBSITE_ENDPOINT_NAME, SsrController } from './ssr';
import { dumpTemplate, mergeTemplates, readTemplates } from './templates';
import { users } from './users';
import { sort, union } from './utils/arrays';
import { difference, differenceBy, order } from './utils/arrays';
import { forEachKey, toPairs } from './utils/objects';
import { upperFirst } from './utils/strings';
import { getBackendWebpackConfig, getFrontendWebpackConfig } from './webpack';
import { zipAll } from './zip';

const { red, bold, green, underline, yellow, cyan, dim } = chalk;

export interface IFileUpload {
    file: File;
    bucketName: string;
    result: S3.PutObjectOutput;
}

// Static assets are cached for a year
const staticAssetsCacheDuration = 31556926;

const dbTableMigrationVersion = '0.0.3';
const localDbPortNumber = 54320;

export class Broiler {

    private readonly config: BroilerConfig;
    // The name of the stack to be deployed
    private readonly stackName: string;
    // The full path to the build directory inside the stage directory
    private readonly buildDir: string;

    private readonly cloudFormation: AmazonCloudFormation;
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
        const stageDir = path.join(projectRootPath, '.broiler', stage);
        const buildDir = this.buildDir = path.join(stageDir, 'build');

        this.cloudFormation = new AmazonCloudFormation(region, stackName);
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
        await Promise.all([
            this.initialize().then(() => (
                this.uploadDatabaseTableResource()
            )),
            this.compileFrontend(false),
            this.compileBackend(false),
            this.deployVpc(),
        ]);
        await this.uploadBackend();
        await this.deployStack();
        await this.uploadFrontend();
        this.log(`${green('Deployment complete!')} The web app is now available at ${underline(`${this.config.serverRoot}/`)}`);
        await this.printAuthClientInfo();
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
        const {DeploymentManagementS3BucketName, AssetsS3BucketName} = output;
        // Empty the deployement bucket
        const iterators = [this.s3.emptyBucket(DeploymentManagementS3BucketName)];
        if (AssetsS3BucketName) {
            iterators.push(this.s3.emptyBucket(AssetsS3BucketName));
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

    public async compile(analyze = true): Promise<WebpackStats[]> {
        await this.clean();
        const [backend, frontend] = await Promise.all([
            this.compileBackend(analyze),
            this.compileFrontend(analyze),
        ]);
        return backend ? [backend, frontend] : [frontend];
    }

    /**
     * Compiles the assets with Webpack to the build directory.
     */
    public async compileFrontend(analyze: boolean): Promise<WebpackStats> {
        this.log(`Compiling the ${this.config.debug ? yellow('debugging') : cyan('release')} version of the app frontend for the stage ${bold(this.config.stage)}...`);
        const stats = await compile(getFrontendWebpackConfig({
            ...this.config,
            devServer: false,
            analyze,
        }));
        this.log(stats.toString({colors: true}));
        return stats;
    }

    /**
     * Compiles the backend code with Webpack to the build directory.
     */
    public async compileBackend(analyze: boolean): Promise<WebpackStats> {
        this.log(`Compiling the ${this.config.debug ? yellow('debugging') : cyan('release')} version of the app backend for the stage ${bold(this.config.stage)}...`);
        const stats = await compile(getBackendWebpackConfig({...this.config, devServer: false, analyze}));
        this.log(stats.toString({colors: true}));
        return stats;
    }

    /**
     * Preview the changes that would be deployed.
     */
    public async preview() {
        await this.compile(false);
        const templateUrl = await this.prepareStackTemplate();
        const parameters = await this.getStackParameters();
        const changeSet = await this.cloudFormation.createChangeSet(templateUrl, parameters);
        this.logChangeSet(changeSet);
        await this.cloudFormation.deleteChangeSet(changeSet.ChangeSetName as string);
    }

    /**
     * Prints the CloudFormation stack template.
     */
    public async printTemplate() {
        await this.compile(false);
        const template = await this.generateTemplate();
        this.log(dumpTemplate(template));
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
        const tables = this.getTables();
        let dbConnectionPool: Pool | null = null;
        if (tables.length) {
            process.stdout.write(`Connecting to the database...`);
            // Ensure that the database is running
            await launchLocalDatabase({ ...opts, port: localDbPortNumber });
            const client = await retryWithBackoff(10, async () => {
                process.stdout.write(`.`);
                const client = new Client(`postgres://postgres@localhost:${localDbPortNumber}/postgres`);
                await client.connect();
                return client;
            });
            process.stdout.write(` ${green('✔︎')}\n`);
            // Run migrations for each table
            try {
                const tableStates = tables.map((table) => table.getState());
                for (const tableState of tableStates) {
                    await createTable(client, tableState);
                }
            } finally {
                await client.end();
            }
            dbConnectionPool = new Pool({
                host: 'localhost',
                port: 54320,
                database: 'postgres',
                user: 'postgres',
                idleTimeoutMillis: 60 * 1000,
            });
        }
        await Promise.all([
            serveFrontEnd(opts, () => this.log(`Serving the local development website at ${underline(`${opts.serverRoot}/`)}`)),
            serveBackEnd(opts, params, dbConnectionPool),
        ]);
    }

    /**
     * Outputs information about the stack.
     */
    public async printStack(): Promise<IStackWithResources> {
        const stack = await this.cloudFormation.describeStackWithResources();
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
        await this.printAuthClientInfo();
        return stack;
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

    public async printTables() {
        const tables = this.getTables();
        // TODO: List database tables that have actually been created, and probably their schemas!
        if (!tables.length) {
            this.log(`Your app does not define any database tables.`);
            return;
        }
        for (const table of tables) {
            this.log(`${table.resource.name} ${dim('[?]')}`);
        }
    }

    public async printTableRows(tableName: string, pretty: boolean) {
        const table = this.getTable(tableName);
        const dbClient = await this.getDatabaseClient();
        for await (const items of dbClient.scan(scan(table.resource))) {
            for (const item of items) {
                const serializedItem = table.resource.serialize(item);
                this.log(JSON.stringify(serializedItem, null, pretty ? 4 : undefined));
            }
        }
    }

    public async uploadTableRows(tableName: string, filePath: string) {
        const table = this.getTable(tableName);
        const dbClient = await this.getDatabaseClient();
        let index = 0;
        for await (const line of readLines(filePath)) {
            index ++;
            try {
                const serializedItem = JSON.parse(line);
                const item = table.resource.deserialize(serializedItem);
                await dbClient.run(write(table.resource, item));
                this.log(`Line ${index} ${green('✔︎')}`);
            } catch (err) {
                this.log(`Line ${index} ${red('×')}`);
                this.logError(err.stack);
            }
        }
    }

    public async backupDatabase(dirPath?: string | null) {
        const basePath = dirPath || generateBackupDirPath(this.config.stageDir);
        const dbClient = await this.getDatabaseClient();
        const tables = this.getTables();
        this.log(`Backing up ${tables.length} database tables…`);
        await ensureDirectoryExists(basePath);
        const results = await Promise.all(tables.map(async (table) => {
            const { resource } = table;
            const { name } = resource;
            this.log(`${dim('Backing up')} ${name}`);
            try {
                const filePath = path.resolve(basePath, `${name}.jsonl`);
                await writeAsyncIterable(filePath, mapAsync(dbClient.scan(scan(resource)), (rows) => {
                    const jsonRows = rows.map((record) => {
                        const serializedItem = resource.serialize(record);
                        return JSON.stringify(serializedItem) + '\n';
                    });
                    return jsonRows.join('');
                }));
                this.log(`${name} ${green('✔︎')}`);
                return null;
            } catch (error) {
                this.log(`${name} ${red('×')}`);
                return error;
            }
        }));
        const error = results.find((error) => error != null);
        if (error) {
            throw error;
        }
        this.log(`Successfully backed up ${tables.length} database tables to:\n${basePath}`);
    }

    public async executeSql(sql: string, params: any[]) {
        const connect = await this.getDatabaseConnector();
        const sqlConnection = await connect();
        try {
            const result = await sqlConnection.query(sql, params);
            for (const row of result.rows) {
                this.log(JSON.stringify(row));
            }
        } finally {
            sqlConnection.disconnect();
        }
    }

    public async restoreDatabase(dirPath: string, overwrite: boolean = false) {
        const dbClient = await this.getDatabaseClient();
        const tables = this.getTables();
        this.log(`Restoring ${tables.length} database tables…`);
        const results = await Promise.all(tables.map(async (table) => {
            const { resource } = table;
            const { name } = resource;
            this.log(`${dim('Restoring')} ${name}`);
            try {
                const filePath = path.resolve(dirPath, `${name}.jsonl`);
                let index = 0;
                for await (const line of readLines(filePath)) {
                    index ++;
                    try {
                        const serializedItem = JSON.parse(line);
                        const item = resource.deserialize(serializedItem);
                        const operation = overwrite ? write(resource, item) : create(resource, item);
                        try {
                            await dbClient.run(operation);
                        } catch (error) {
                            if (!isResponse(error, HttpStatus.PreconditionFailed)) {
                                throw error;
                            }
                        }
                    } catch (err) {
                        this.log(`${name}: line ${index} ${red('×')}`);
                        this.logError(err.stack);
                    }
                }
                this.log(`${name} ${green('✔︎')}`);
                return null;
            } catch (error) {
                this.log(`${name} ${red('×')}`);
                return error;
            }
        }));
        const error = results.find((error) => error != null);
        if (error) {
            throw error;
        }
        this.log(`Successfully restored ${results.length} database tables!`);
    }

    public async openPsql(): Promise<void> {
        const { name, stage } = this.config;
        this.log(`Opening PostgreSQL shell...`);
        await openLocalDatabasePsql(name, stage);
        this.log(`PostgreSQL shell exited successfully!`);
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
        const {serverRoot, assetsRoot} = this.config;
        const siteRootUrl = new URL(serverRoot);
        const siteHostedZone = getHostedZone(siteRootUrl.hostname);
        const assetsRootUrl = new URL(assetsRoot);
        const assetsHostedZone = getHostedZone(assetsRootUrl.hostname);
        const rawHostedZones = [siteHostedZone, assetsHostedZone];
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

    public async deployVpc(): Promise<void> {
        const { vpc, region } = this.config;
        if (!vpc) {
            // This stack does not use a VPC
            return;
        }
        const vpcStackName = `${vpc}-vpc`;
        const template = await readTemplates(['cloudformation-vpc.yml']);
        const templateStr = dumpTemplate(template);
        const stackParameters = {};
        const vpcCloudFormation = new AmazonCloudFormation(region, vpcStackName);
        try {
            let oldStack = await vpcCloudFormation.describeStackWithResources();
            // Update an existing VPC stack
            this.log(`Updating the existing VPC stack ${bold(vpcStackName)} in region ${bold(region)}...`);
            const execution$ = vpcCloudFormation.updateStack(templateStr, stackParameters);
            let hasChanges = false;
            for await (const newStack of execution$) {
                hasChanges = true;
                this.logStackChanges(oldStack, newStack);
                oldStack = newStack;
            }
            if (hasChanges) {
                this.log(`Existing VPC stack ${bold(vpcStackName)} updated successfully!`, green('✔︎'));
            } else {
                this.log(`Existing VPC stack ${bold(vpcStackName)} is already up-to-date!`, green('✔︎'));
            }
        } catch (error) {
            // Check if the message indicates that the stack was not found
            if (!isDoesNotExistsError(error)) {
                // Pass the error through
                throw error;
            }
            // Create a new VPC stack
            this.log(`Creating a new VPC stack ${bold(vpcStackName)} to region ${bold(region)}...`);
            let oldStack = {} as IStackWithResources;
            const execution$ = vpcCloudFormation.createStack(templateStr, stackParameters);
            for await (const newStack of execution$) {
                this.logStackChanges(oldStack, newStack);
                oldStack = newStack;
            }
            this.log(`VPC stack ${bold(vpcStackName)} created successfully!`, green('✔︎'));
        }
    }

    /**
     * Deploys the compiled asset files from the build directory to the
     * Amazon S3 buckets in the deployed stack.
     */
    public async uploadFrontend(): Promise<IFileUpload[]> {
        const asset$ = searchFiles(this.buildDir, ['!index.*.html', '!server*.js']);
        const output = await this.cloudFormation.getStackOutput();
        return await toArray(this.uploadFilesToS3Bucket(
            output.AssetsS3BucketName, asset$, staticAssetsCacheDuration, false,
        ));
    }

    /**
     * Returns the parameters that are given to the CloudFormation template.
     */
    public async getStackParameters() {
        const {serverRoot, assetsRoot, auth, parameters, vpc} = this.config;
        const serverRootUrl = new URL(serverRoot);
        const serverDomain = serverRootUrl.hostname;
        const assetsRootUrl = new URL(assetsRoot);
        const assetsDomain = assetsRootUrl.hostname;
        const serverFileKey$ = this.getServerZipFileS3Key();
        const prevParams$ = auth ? this.cloudFormation.getStackParameters() : Promise.resolve(undefined);
        const tables = this.getTables();
        const databaseName = tables.length ? this.getDatabaseName() : undefined;
        const [serverFileKey, prevParams] = await Promise.all([serverFileKey$, prevParams$]);
        const vpcStackName = vpc == null ? undefined : `${vpc}-vpc`;
        const dbTableMigrationDeploymentPackageS3Key = tables.length
            ? `cloudformation-migration-lambda-${dbTableMigrationVersion}.zip`
            : undefined;
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
            ServerRoot: serverRoot,
            ServerOrigin: serverRootUrl.origin,
            ServerDomainName: serverDomain,
            ServerHostedZoneName: getHostedZone(serverDomain),
            ServerRequestLambdaFunctionS3Key: serverFileKey,
            AssetsRoot: assetsRoot,
            AssetsDomainName: assetsDomain,
            AssetsHostedZoneName: getHostedZone(assetsDomain),
            // These are only used if the database is enabled
            VpcStackName: vpcStackName,
            DatabaseName: databaseName,
            DatabaseTableMigrationDeploymentPackageS3Key: dbTableMigrationDeploymentPackageS3Key,
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
     * Uploads a CloudFormation Lambda JavaScript source code
     * required for database table migrations. Any existing files
     * are overwritten.
     */
    private async uploadDatabaseTableResource(): Promise<S3.PutObjectOutput> {
        const packageFileName = 'cloudformation-migration-lambda.zip';
        const bucketName$ = this.cloudFormation.getStackOutput().then((output) => output.DeploymentManagementS3BucketName);
        const resDir = path.join(__dirname, 'res');
        const packageFile$ = readFileBuffer(path.join(resDir, packageFileName));
        return Promise.all([bucketName$, packageFile$])
            .then(([bucketName, packageFile]) => this.createS3File$({
                Bucket: bucketName,
                Key: `cloudformation-migration-lambda-${dbTableMigrationVersion}.zip`,
                Body: packageFile,
                ContentType: 'application/zip',
            }, true));
    }

    /**
     * Deploys the compiled server-side files from the build directory to the
     * Amazon S3 buckets in the deployed stack.
     */
    private async uploadBackend() {
        const [serverFile, htmlFile] = await Promise.all([
            this.getCompiledServerFile(),
            this.getCompiledHtmlFile(),
        ]);
        const zipFileData$ = zipAll([
            {filename: 'server.js', data: serverFile.contents},
            {filename: 'index.html', data: htmlFile.contents},
        ]);
        const output$ = this.cloudFormation.getStackOutput();
        const [output, zipFileData, key] = await Promise.all([
            output$, zipFileData$, this.getServerZipFileS3Key(),
        ]);
        const bucketName = output.DeploymentManagementS3BucketName;
        this.log(`Zipped the server implementation as ${bold(key)}`);
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
        return toArray(clean(this.buildDir));
    }

    private async generateTemplate(): Promise<any> {
        const server = this.importServer();
        // TODO: At this point validate that the endpoint configuration looks legit?
        const templateFiles = [
            'cloudformation-init.yml',
            'cloudformation-app.yml',
        ];
        const {auth, parameters} = this.config;
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
        const tables = this.getTables();
        if (auth || tables.length) {
            // Generic custom resource is used in user or database related items
            templateFiles.push('cloudformation-custom-resource.yml');
        }
        const siteHash = await this.getSiteHash();
        const template$ = readTemplates(templateFiles, {
            ServerDeploymentId: siteHash.toUpperCase(),
        });
        if (!server) {
            return await template$;
        }
        const templates = await Promise.all([
            template$,
            this.generateDbTemplates(),
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
                        ServerApiGatewayStage: {
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

    private async generateDbTemplates(): Promise<any> {
        const tables = this.getTables();
        if (!tables.length) {
            return {};
        }
        const dbSetupTemplate = await readTemplates(['cloudformation-db.yml']);
        return tables
            .map((table) => this.generateDbTableTemplate(table))
            .reduce(mergeTemplates, dbSetupTemplate);
    }

    private generateDbTableTemplate(table: Table) {
        const logicalId = `DatabaseTable${upperFirst(table.resource.name)}`;
        const tableProperties = {
            ServiceToken: { 'Fn::GetAtt': 'DatabaseMigrationLambdaFunction.Arn' },
            Host: { 'Fn::GetAtt': 'DatabaseDBCluster.Endpoint.Address' },
            Database: { Ref: 'DatabaseName' },
            Port: { 'Fn::GetAtt': 'DatabaseDBCluster.Endpoint.Port' },
            Region: { Ref: 'AWS::Region' },
            SecretId: { Ref: 'DatabaseMasterSecret' },
            Table: table.getState(),
        };
        return {
            // Create the AuroraDB table
            Resources: {
                [logicalId]: {
                    Type: 'Custom::DatabaseTable',
                    Properties: tableProperties,
                    DependsOn: ['DatabaseMigrationLogGroup'],
                },
            },
        };
    }

    private async createS3File$(params: S3.PutObjectRequest, overwrite: true): Promise<S3.PutObjectOutput>;
    private async createS3File$(params: S3.PutObjectRequest, overwrite: boolean): Promise<S3.PutObjectOutput | void>;
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

    private async getCompiledHtmlFile(): Promise<File> {
        const files = await searchFiles(this.buildDir, ['index.*.html']);
        if (files.length !== 1) {
            throw new Error(`Couldn't find the compiled HTML file!`);
        }
        return files[0];
    }

    private async getCompiledServerFile(): Promise<File> {
        const files = await searchFiles(this.buildDir, ['server.*.js']);
        if (files.length !== 1) {
            throw new Error(`Couldn't find the compiled server-site renderer bundle!`);
        }
        return files[0];
    }

    private async getServerZipFileS3Key(): Promise<string> {
        const siteHash = await this.getSiteHash();
        return formatS3KeyName(`server.${siteHash}.zip`);
    }

    private async getSiteHash(): Promise<string> {
        const [serverFile, htmlFile] = await Promise.all([
            this.getCompiledServerFile(), this.getCompiledHtmlFile(),
        ]);
        const [, serverFileHash] = serverFile.basename.split('.');
        const [, htmlFileHash] = htmlFile.basename.split('.');
        return `${serverFileHash}${htmlFileHash}`;
    }

    private async printAuthClientInfo() {
        const {auth} = this.config;
        if (!auth) {
            // Nothing to print
            return;
        }
        const output = await this.cloudFormation.getStackOutput();
        const authRoot = output.UserPoolRoot;
        if (!authRoot) {
            return;
        }
        const oauthRedirectUri = `${authRoot}/oauth2/idpresponse`;
        // Facebook client settings
        const facebookClientId = auth.facebookClientId;
        if (facebookClientId) {
            const conifigureUrl = `https://developers.facebook.com/apps/${facebookClientId}/fb-login/settings/`;
            this.log(
                `\n` +
                yellow(`${bold(`Remember to configure your Facebook client`)} with ID ${facebookClientId}`) +
                `\n1. Navigate to the app's ${bold(`Facebook Login`)} settings at:` +
                `\n   ${underline(conifigureUrl)}` +
                `\n2. Add the following URL to the ${bold(`"Valid OAuth Redirect URIs"`)}:` +
                `\n   ${underline(oauthRedirectUri)}`,
            );
        }
        // Google client settings
        const googleClientId = auth.googleClientId;
        if (googleClientId) {
            const conifigureUrl = `https://console.developers.google.com/apis/credentials/oauthclient/${googleClientId}`;
            this.log(
                `\n` +
                yellow(`${bold(`Remember to configure your Google client`)} with ID ${googleClientId}`) +
                `\n1. Navigate to the app's ${bold(`Client ID settings`)} at` +
                `\n   ${underline(conifigureUrl)}` +
                `\n2. Add the following URL to the ${bold(`"Authorized redirect URIs"`)}:` +
                `\n   ${underline(oauthRedirectUri)}`,
            );
        }
    }

    private log(message: any, ...params: any[]) {
        // tslint:disable-next-line:no-console
        console.log(message, ...params);
    }
    private logError(message: any, ...params: any[]) {
        // tslint:disable-next-line:no-console
        console.error(red(message), ...params);
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
        const { serverFile, projectRootPath, sourceDir, siteFile } = this.config;
        if (serverFile) {
            const serverModule = require(path.resolve(projectRootPath, sourceDir, serverFile));
            const siteModule = require(path.resolve(projectRootPath, sourceDir, siteFile));
            const apiService = new ApiService(serverModule.default);
            const view = siteModule.default;
            return apiService.extend({
                [RENDER_WEBSITE_ENDPOINT_NAME]: new SsrController(apiService, view, Promise.resolve('')),
                [OAUTH2_SIGNIN_ENDPOINT_NAME]: new OAuth2SignInController(),
                [OAUTH2_SIGNOUT_ENDPOINT_NAME]: new OAuth2SignOutController(),
                [OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedInController(),
                [OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedOutController(),
            });
        }
        return null;
    }

    private getDatabaseName() {
        const { stackName } = this.config;
        return stackName.split('-').join('_');
    }

    private getDatabase(): Database {
        const { databaseFile, projectRootPath, sourceDir } = this.config;
        if (!databaseFile) {
            throw new Error(`Database not defined for the app`);
        }
        const dbModulePath = path.resolve(projectRootPath, sourceDir, databaseFile);
        const dbModule = require(dbModulePath);
        const db = dbModule.default;
        if (db == null || typeof db !== 'object') {
            throw new Error(`The database file ${databaseFile} needs to export database instance as a default export`);
        }
        return db;
    }

    private getTables() {
        const { region, auth } = this.config;
        let db;
        try {
            db = this.getDatabase();
        } catch {
            return [];
        }
        const tables = db.tables.slice();
        if (auth && region === 'local') {
            tables.push(new DatabaseTable(users, []));
        }
        return sort(tables, (table) => table.resource.name, 'asc');
    }

    private getTable(tableName: string) {
        const table = this.getTables().find(({ resource }) => resource.name === tableName);
        if (!table) {
            throw new Error(`Table ${tableName} not found.`);
        }
        return table;
    }

    private async getDatabaseConnector(): Promise<() => Promise<SqlConnection>> {
        const { region } = this.config;
        if (region === 'local') {
            return async () => {
                const client = new Client(`postgres://postgres@localhost:${localDbPortNumber}/postgres`);
                await client.connect();
                return new PostgreSqlConnection(client);
            };
        }
        const output = await this.cloudFormation.getStackOutput();
        return async () => new RemotePostgreSqlConnection(
            region,
            output.DatabaseDBClusterArn,
            output.DatabaseMasterSecretArn,
            this.getDatabaseName(),
        );
    }

    private async getDatabaseClient(): Promise<DatabaseClient> {
        const db = this.getDatabase();
        const connect = await this.getDatabaseConnector();
        return new DatabaseClient(db, connect);
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

function formatStatus(status: string): string {
    if (status.endsWith('_FAILED')) {
        return red(status);
    } else if (status.endsWith('_COMPLETE')) {
        return green(status);
    } else {
        return cyan(status);
    }
}

function generateBackupDirPath(stageDir: string): string {
    const timestamp = new Date().toISOString();
    return path.resolve(stageDir, './backups', timestamp.replace(/[:.-]/g, ''));
}
