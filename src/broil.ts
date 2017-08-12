#! /usr/bin/env node
import * as yargs from 'yargs';

import { Broiler } from './broiler';
import { IAppConfigOptions, readAppConfig$ } from './config';
import { execute$ } from './exec';

// Allow loading TypeScript (.ts) files using `require()` commands
import 'ts-node/register';

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
                .subscribe()
            ;
        },
    })
    .command({
        command: 'deploy <stage>',
        describe: 'Deploy the web app for the given stage.',
        handler: (argv: IAppConfigOptions) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).deploy$())
                .subscribe()
            ;
        },
    })
    .command({
        command: 'undeploy <stage>',
        describe: 'Deletes the previously deployed web app for the given stage.',
        handler: (argv: IAppConfigOptions) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).undeploy$())
                .subscribe()
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
                .subscribe()
            ;
        },
    })
    .command({
        command: 'describe <stage>',
        describe: 'Describes the deployed resources of the given stage.',
        handler: (argv) => {
            readAppConfig$(argv)
                .switchMap((config) => new Broiler(config).printStack$())
                .subscribe()
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
                .subscribe()
            ;
        },
    })
    .demandCommand(1)
    .wrap(Math.min(yargs.terminalWidth(), 140))
    .help()
    .version()
    .argv
;
