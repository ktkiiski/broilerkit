#! /usr/bin/env node
import * as _ from 'lodash';
import * as path from 'path';
import { Observable } from 'rxjs';
import * as File from 'vinyl';
import * as YAML from 'yamljs';
import * as yargs from 'yargs';

import { AWS } from './aws';
import { clean } from './clean';
import { compile } from './compile';
import { IAppConfigOptions, readAppConfig$ } from './config';
import { src$ } from './utils';

// Static assets are cached for a year
const staticAssetsCacheDuration = 31556926;
// HTML pages are cached for an hour
const staticHtmlCacheDuration = 3600;

/* tslint:disable:no-console */
// tslint:disable-next-line:no-unused-expression
yargs
    // Read the Webpack configuration
    .describe('webpackConfigPath', 'Path to the Webpack configuration file')
    .default('webpackConfigPath', './webpack.config.js')
    .alias('webpackConfigPath', 'webpackConfig')
    .normalize('webpackConfigPath')
    // Read the TypeScript configuration.
    .describe('tsconfigPath', 'Path to the TypeScript configuration file')
    .default('tsconfigPath', './tsconfig.json')
    .alias('tsconfigPath', 'tsconfig')
    .normalize('tsconfigPath')
    // Read the CloudFormation template
    .describe('templatePath', 'Path to the CloudFormation template')
    .default('templatePath', './cloudformation.yml')
    .alias('templatePath', 'template')
    .normalize('templatePath')
    // Read the app configuration
    .describe('appConfigPath', 'Path to the app configuration')
    .default('appConfigPath', './site.config.js')
    .alias('appConfigPath', 'appConfig')
    .normalize('appConfigPath')

    .boolean('debug')
    .describe('debug', 'Compile assets for debugging')

    /**** Commands ****/
    .command({
        command: 'deploy <stage>',
        describe: 'Deploy the web app for the given stage.',
        handler: (argv: IAppConfigOptions) => {
            readAppConfig$(argv)
                .switchMap((config) => {
                    const aws = new AWS(config);
                    return aws.deployStack$(
                        {
                            ServiceName: config.stackName,
                            SiteDomainName: config.siteDomain,
                            SiteHostedZoneName: getHostedZone(config.siteDomain),
                            AssetsDomainName: config.assetsDomain,
                            AssetsHostedZoneName: getHostedZone(config.assetsDomain),
                        },
                    )
                    .map((stack) => stack.StackResources)
                    .startWith([])
                    .pairwise()
                    .switchMap(([prevResources, nextResources]) =>
                        _.differenceBy(nextResources, prevResources, (resource) => `${resource.LogicalResourceId}:${resource.ResourceStatus}`),
                    )
                    .do({
                        next: (resource) => console.log(`Resource ${resource.LogicalResourceId} => ${resource.ResourceStatus} ${resource.ResourceStatusReason || ''}`),
                    })
                    .last()
                    .combineLatest(
                        compile({
                            baseUrl: `https://${config.assetsDomain}/`,
                            buildDir: config.buildDir,
                            debug: config.debug,
                            devServer: false,
                            iconFile: config.iconFile,
                            webpackConfigPath: config.webpackConfigPath,
                        })
                        .do((stats) => console.log(stats.toString({colors: true}))),
                    )
                    .first()
                    .switchMapTo(aws.getStackOutput$())
                    .switchMap((output) =>
                        Observable.concat(
                            uploadFilesToS3Bucket$(
                                aws, output.AssetsS3BucketName, src$([
                                    path.join(config.buildDir, '**/*'),
                                    '!' + path.join(config.buildDir, '**/*.html'),
                                ]), staticAssetsCacheDuration,
                            ),
                            uploadFilesToS3Bucket$(
                                aws, output.SiteS3BucketName, src$([
                                    path.join(config.buildDir, '**/*.html'),
                                ]), staticHtmlCacheDuration,
                            ),
                        ),
                    )
                    .do({
                        complete: () => console.log(`Deployment complete! The web app is now available at https://${config.siteDomain}`),
                    });
                })
                .subscribe()
            ;
        },
    })
    .command({
        command: 'compile <stage>',
        aliases: ['build'],
        describe: 'Compile the web app for the given stage.',
        builder: {
            stage: {
                config: true,
                configParser: (stageName: string) => readStageConfig('./site.config.js', stageName),
            },
        },
        handler: (argv) => {
            console.log(`Compiling the app for the stage ${argv.stage}...`);
            compileClean(argv)
                .subscribe((stats) => {
                    console.log(stats.toString({colors: true}));
                })
            ;
        },
    })
    .command({
        command: 'clean',
        aliases: ['clear'],
        describe: 'Removes the contents of the build directory.',
        handler: (argv) => {
            console.log(`Removing the contents of ${argv.buildDir}...`);
            clean(argv.buildDir).subscribe((files) => {
                console.log(`Removed ${files.length} files:`);
                files.forEach((file) => console.log(file));
            });
        },
    })
    .demandCommand(1)
    .help()
    .argv
;

function uploadFilesToS3Bucket$(aws: AWS, bucketName: string, file$: Observable<File>, cacheDuration: number) {
    return file$
        .filter((file) => !file.isDirectory())
        .mergeMap((file) => aws.uploadFileToS3Bucket$(
            bucketName, file, 'public-read', cacheDuration,
        ), 3)
    ;
}
/* tslint:enable:no-console */

function compileClean(argv: any) {
    const webpackConfig = argv.webpackConfig(argv);
    return clean(argv.buildDir)
        .switchMapTo(compile(webpackConfig))
    ;
}

function readConfigFile(configFile: string): any {
    const cwd = process.cwd();
    const configPath = path.resolve(cwd, configFile);
    if (/\.(js|json)$/.test(configPath)) {
        return require(configPath);
    }
    return YAML.load(configFile);
}

function readStageConfig(configFile: string, stageName: string) {
    const {stages, ...siteConfig} = readConfigFile(configFile);
    const stageConfig = stages[stageName];
    return {
        ...siteConfig,
        ...stageConfig,
        stage: stageName,
        baseUrl: `https://${stageConfig.assetsDomain}/`,
        stackName: `${siteConfig.appName}-${stageName}`,
    };
}

function getHostedZone(domain: string) {
    const match = /([^.]+\.[^.]+)$/.exec(domain);
    return match && match[0];
}
