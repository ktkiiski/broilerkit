#! /usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as childProcess from 'child_process';
import * as path from 'path';
import * as yargs from 'yargs';
import { Broiler } from './broiler';
import { escapeForShell } from './exec';
import type { App } from './index';
import { red } from './palette';

// Allow executing TypeScript (.ts) files
import * as tsNode from 'ts-node';

const onError = (error: Error) => {
    process.exitCode = 1;
    console.error(red(String(error.stack || error)));
};

interface CommandOptions {
    appConfigPath: string;
    stage: string;
    debug: boolean;
}

function getBroiler(argv: CommandOptions) {
    tsNode.register({
        transpileOnly: true,
        compilerOptions: {
            module: 'CommonJS',
        },
    });
    const { appConfigPath, ...options } = argv;
    const cwd = process.cwd();
    const appPath = path.resolve(cwd, appConfigPath);
    const projectRootPath = path.dirname(appPath);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appModule = require(appPath);
    const app: App = appModule.default; // App should be the default export
    return new Broiler(app.configure({ ...options, projectRootPath }));
}
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
        builder: (cmdYargs) =>
            cmdYargs
                .default('directory', './')
                .normalize('directory')
                .describe('template', 'Name of the Broilerplate branch to apply.')
                .default('template', 'master'),
        describe: 'Bootstrap your app with Broilerplate template.',
        handler: ({ template, directory }: { template: string; directory: string }) => {
            const options: childProcess.ExecSyncOptions = { cwd: directory, stdio: 'inherit' };
            childProcess.execSync(`git init ${escapeForShell(directory)}`, options);
            childProcess.execSync(
                `git pull https://github.com/ktkiiski/broilerplate.git ${escapeForShell(
                    template,
                )} --allow-unrelated-histories`,
                options,
            );
            childProcess.execSync(`npm install`, options);
        },
    })
    .command({
        command: 'deploy <stage>',
        describe: 'Deploy the web app for the given stage.',
        builder: (cmdYargs) => cmdYargs.boolean('init').describe('init', 'Just create the stack (no deployment)'),
        handler: (argv: any) => {
            const broiler = getBroiler(argv);
            if (argv.init) {
                broiler.initialize().catch(onError);
            } else {
                broiler.deploy().catch(onError);
            }
        },
    })
    .command({
        command: 'undeploy <stage>',
        describe: 'Deletes the previously deployed web app.',
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.undeploy().catch(onError);
        },
    })
    .command({
        command: 'logs <stage> [since]',
        describe: 'Print app logs.',
        builder: (cmdYargs) =>
            cmdYargs
                .boolean('f')
                .describe('f', 'Wait for additional logs and print them')
                .describe('since', 'How old logs should be printed, e.g. 1min, 2h, 3d')
                .number('n')
                .describe('n', 'Number of log entries to print'),
        handler: (argv: any) => {
            const broiler = getBroiler(argv);
            broiler
                .printLogs({
                    follow: argv.f,
                    since: argv.since,
                    maxCount: argv.n,
                })
                .catch(onError);
        },
    })
    .command({
        command: 'compile <stage>',
        aliases: ['build'],
        describe: 'Compile the web app.',
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.compile().catch(onError);
        },
    })
    .command({
        command: 'preview <stage>',
        describe: 'Preview the changes that would be deployed.',
        builder: (cmdYargs) =>
            cmdYargs.boolean('template').describe('template', 'Preview the CloudFormation stack template'),
        handler: (argv: any) => {
            const broiler = getBroiler(argv);
            if (argv.template) {
                broiler.printTemplate().catch(onError);
            } else {
                broiler.preview().catch(onError);
            }
        },
    })
    .command({
        command: 'describe <stage>',
        describe: 'Describes the deployed resources.',
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.printStack().catch(onError);
        },
    })
    .command({
        command: 'serve [stage]',
        describe: 'Run the local development server.',
        builder: (cmdYargs) => cmdYargs.default('stage', 'local'),
        handler: (argv: CommandOptions) => {
            const broiler = getBroiler(argv);
            broiler.serve().catch(onError);
        },
    })
    .command({
        command: 'db <command>',
        describe: 'Manage database tables',
        builder: (cmdYargs) =>
            cmdYargs
                .command({
                    command: 'list <stage>',
                    describe: 'List database tables',
                    handler: (argv: CommandOptions) => {
                        const broiler = getBroiler(argv);
                        broiler.printTables().catch(onError);
                    },
                })
                .command({
                    command: 'sql <stage> <sql> [params...]',
                    describe: 'Execute an SQL statement',
                    handler: (argv: CommandOptions & { sql: string; params: string[] }) => {
                        const broiler = getBroiler(argv);
                        broiler.executeSql(argv.sql, argv.params).catch(onError);
                    },
                })
                .command({
                    command: 'dump <stage> <table>',
                    describe: 'Print out all the records from a table',
                    builder: (subCmdYargs) => subCmdYargs.boolean('pretty').describe('pretty', 'Print formatted JSON'),
                    handler: (argv: any) => {
                        const broiler = getBroiler(argv);
                        broiler.printTableRows(argv.table, argv.pretty).catch(onError);
                    },
                })
                .command({
                    command: 'upload <stage> <table>',
                    describe: 'Write records to a database table',
                    builder: (subCmdYargs) =>
                        subCmdYargs.option('file', {
                            alias: 'f',
                            demandOption: true,
                            normalize: true,
                            describe: 'File from which the records are read',
                            type: 'string',
                        }),
                    handler: (argv: any) => {
                        const broiler = getBroiler(argv);
                        broiler.uploadTableRows(argv.table, argv.file).catch(onError);
                    },
                })
                .command({
                    command: 'backup <stage>',
                    describe: 'Saves contents of all tables to a local directory',
                    builder: (subCmdYargs) =>
                        subCmdYargs.option('path', {
                            alias: 'p',
                            normalize: true,
                            describe: 'Path to the backup directory',
                            type: 'string',
                        }),
                    handler: (argv: any) => {
                        const broiler = getBroiler(argv);
                        broiler.backupDatabase(argv.path).catch(onError);
                    },
                })
                .command({
                    command: 'restore <stage>',
                    describe: 'Uploads database contents from a local backup directory',
                    builder: (subCmdYargs) =>
                        subCmdYargs
                            .option('path', {
                                alias: 'p',
                                demandOption: true,
                                normalize: true,
                                describe: 'Path to the backup directory',
                                type: 'string',
                            })
                            .option('overwrite', {
                                alias: 'o',
                                describe: 'Overwrite existing records',
                                type: 'boolean',
                            }),
                    handler: (argv: any) => {
                        const broiler = getBroiler(argv);
                        broiler.restoreDatabase(argv.path, argv.overwrite).catch(onError);
                    },
                })
                .command({
                    command: 'psql [stage]',
                    describe: 'Open psql shell for local stage database',
                    builder: (subCmdYargs) => subCmdYargs.default('stage', 'local'),
                    handler: (argv: CommandOptions) => {
                        const broiler = getBroiler(argv);
                        broiler.openPsql().catch(onError);
                    },
                }),
        handler: () => {
            /* do nothing */
        },
    })
    .demandCommand(1)
    .wrap(Math.min(yargs.terminalWidth(), 100))
    .help()
    .version().argv;
