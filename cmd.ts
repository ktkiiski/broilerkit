#! /usr/bin/env node
import chalk from 'chalk';
import * as childProcess from 'child_process';
import * as path from 'path';
import * as yargs from 'yargs';
import { Broiler } from './broiler';
import { escapeForShell } from './exec';

// Allow executing TypeScript (.ts) files
import * as tsNode from 'ts-node';

// Polyfill Symbol.asyncIterator
(Symbol as any).asyncIterator = (Symbol as any).asyncIterator || Symbol.for('Symbol.asyncIterator');

const onError = (error: Error) => {
    process.exitCode = 1;
    // tslint:disable-next-line:no-console
    console.error(chalk.red(String(error.stack || error)));
};

interface CommandOptions {
    appConfigPath: string;
    stage: string;
    debug: boolean;
}

function getBroiler(argv: CommandOptions) {
    tsNode.register();
    const { appConfigPath, ...options } = argv;
    const cwd = process.cwd();
    const appPath = path.resolve(cwd, appConfigPath);
    const projectRootPath = path.dirname(appPath);
    const appModule = require(appPath);
    const app = appModule.default; // App should be the default export
    return new Broiler(app.configure({...options, projectRootPath}));
}

// tslint:disable-next-line:no-unused-expression
yargs
    // Read the app configuration
    .describe('appConfigPath', 'Path to the app configuration')
    .default('appConfigPath', 'app.ts')
    .normalize('appConfigPath')

    .boolean('debug')
    .describe('debug', 'Compile assets for debugging')

    .boolean('no-color')
    .describe('no-color', 'Print output without colors')

    /**** Commands ****/
    .command({
        command: 'init [directory]',
        aliases: ['pull'],
        builder: (cmdYargs) => cmdYargs
            .default('directory', './')
            .normalize('directory')
            .describe('template', 'Name of the Broilerplate branch to apply.')
            .default('template', 'master')
        ,
        describe: 'Bootstrap your app with Broilerplate template.',
        handler: ({template, directory}: {template: string, directory: string}) => {
            const options: childProcess.ExecSyncOptions = {cwd: directory, stdio: 'inherit'};
            childProcess.execSync(`git init ${escapeForShell(directory)}`, options);
            childProcess.execSync(`git pull https://github.com/ktkiiski/broilerplate.git ${escapeForShell(template)} --allow-unrelated-histories`, options);
            childProcess.execSync(`npm install`, options);
        },
    })
    .command({
        command: 'deploy <stage>',
        describe: 'Deploy the web app for the given stage.',
        builder: (cmdYargs) => cmdYargs
            .boolean('init')
            .describe('init', 'Just create the stack (no deployment)')
        ,
        handler: (argv: CommandOptions & {init: boolean}) => {
            const broiler = getBroiler(argv);
            if (argv.init) {
                broiler.initialize().then(null, onError);
            } else {
                broiler.deploy().then(null, onError);
            }
        },
    })
    .command({
        command: 'undeploy <stage>',
        describe: 'Deletes the previously deployed web app.',
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.undeploy().then(null, onError);
        },
    })
    .command({
        command: 'logs <stage> [since]',
        describe: 'Print app logs.',
        builder: (cmdYargs) => cmdYargs
            .boolean('f')
            .describe('f', 'Wait for additional logs and print them')
            .describe('since', 'How old logs should be printed, e.g. 1min, 2h, 3d')
            .number('n')
            .describe('n', 'Number of log entries to print')
        ,
        handler: (argv: CommandOptions & {f: boolean, since: string, n: number}) => {
            const broiler = getBroiler(argv);
            broiler.printLogs({
                follow: argv.f,
                since: argv.since,
                maxCount: argv.n,
            }).then(null, onError);
        },
    })
    .command({
        command: 'compile <stage>',
        aliases: ['build'],
        describe: 'Compile the web app.',
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.compile().then(null, onError);
        },
    })
    .command({
        command: 'preview <stage>',
        describe: 'Preview the changes that would be deployed.',
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.preview().then(null, onError);
        },
    })
    .command({
        command: 'describe <stage>',
        describe: 'Describes the deployed resources.',
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.printStack().then(null, onError);
        },
    })
    .command({
        command: 'serve [stage]',
        describe: 'Run the local development server.',
        builder: (cmdYargs) => cmdYargs.default('stage', 'local'),
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.serve().then(null, onError);
        },
    })
    .command({
        command: 'db <command>',
        describe: 'Manage database tables',
        builder: (cmdYargs) => cmdYargs
            .command({
                command: 'list <stage>',
                describe: 'List database tables',
                handler: (argv: CommandOptions) => {
                    const broiler = getBroiler(argv);
                    broiler.printTables().then(null, onError);
                },
            })
        ,
        handler: () => { /* do nothing */ },
    })
    .demandCommand(1)
    .wrap(Math.min(yargs.terminalWidth(), 100))
    .help()
    .version()
    .argv
;
