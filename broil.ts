#! /usr/bin/env node
import * as yargs from 'yargs';

import { red } from 'chalk';
import { Broiler } from './broiler';
import { IAppConfigOptions, readAppConfig$ } from './config';
import { execute$ } from './exec';

// Allow loading TypeScript (.ts) files using `require()` commands
import 'ts-node/register';

const errorHandler = {
    error: (error: Error) => {
        process.exitCode = 1;
        // tslint:disable-next-line:no-console
        console.error(red(String(error.stack || error)));
    },
};

// tslint:disable-next-line:no-unused-expression
yargs
    // Read the app configuration
    .describe('appConfigPath', 'Path to the app configuration')
    .default('appConfigPath', './app.config.ts')
    .alias('appConfigPath', 'appConfig')
    .normalize('appConfigPath')

    .boolean('debug')
    .describe('debug', 'Compile assets for debugging')

    /**** Commands ****/
    .command({
        command: 'init',
        aliases: ['update'],
        describe: 'Initializes/updates your project to use the Broilerplate template.',
        handler: () => {
            execute$('git pull https://github.com/ktkiiski/broilerplate.git master --allow-unrelated-histories')
                .subscribe(errorHandler)
            ;
        },
    })
    .command({
        command: 'deploy <stage>',
        describe: 'Deploy the web app for the given stage.',
        builder: (cmdYargs) => cmdYargs
            .boolean('init')
            .describe('init', 'Just create a stack without deploying')
        ,
        handler: (argv: IAppConfigOptions & {init: boolean}) => {
            readAppConfig$(argv)
                .switchMap((config) => {
                    const broiler = new Broiler(config);
                    if (argv.init) {
                        return broiler.initialize$();
                    }
                    return broiler.deploy$();
                })
                .subscribe(errorHandler)
            ;
        },
    })
    .command({
        command: 'undeploy <stage>',
        describe: 'Deletes the previously deployed web app for the given stage.',
        handler: (argv: IAppConfigOptions) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).undeploy$())
                .subscribe(errorHandler)
            ;
        },
    })
    .command({
        command: 'compile <stage>',
        aliases: ['build'],
        describe: 'Compile the web app for the given stage.',
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).compile$())
                .subscribe(errorHandler)
            ;
        },
    })
    .command({
        command: 'changes <stage>',
        describe: 'Preview the changes that would be deployed without actually deploying them.',
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).preview$())
                .subscribe(errorHandler)
            ;
        }
    })
    .command({
        command: 'describe <stage>',
        describe: 'Describes the deployed resources of the given stage.',
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).printStack$())
                .subscribe(errorHandler)
            ;
        },
    })
    .command({
        command: 'serve [stage]',
        describe: 'Run the local development server',
        builder: (cmdYargs) => cmdYargs.default('stage', 'local'),
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).serve$())
                .subscribe(errorHandler)
            ;
        },
    })
    .demandCommand(1)
    .wrap(Math.min(yargs.terminalWidth(), 140))
    .help()
    .version()
    .argv
;
