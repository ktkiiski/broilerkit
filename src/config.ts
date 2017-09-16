import * as path from 'path';
import { Observable } from 'rxjs';
import * as semver from 'semver';
import { IApiDefinition } from './api';
import { ApiRequestHandler, IApiEndpoint } from './endpoints';
import { HttpMethod } from './http';
import { readConfig$ } from './utils/fs';

export interface IAppConfigOptions {
    appConfigPath: string;
    stage: string;
    debug: boolean;
}

export interface IAppApiEndpointConfig<T> extends IApiDefinition<T> {
    methods: HttpMethod[];
}

export interface IAppConfig extends IAppConfigOptions {
    name: string;
    broilerKitVersion: string;
    assetsOrigin: string;
    apiOrigin: string;
    buildDir: string;
    debug: boolean;
    iconFile: string;
    pages: Array<{
        title: string;
        file: string;
        scripts: string[];
    }>;
    projectRoot: string;
    region: string;
    siteOrigin: string;
    sourceDir: string;
    stackName: string;
    apiPath?: string;
    api?: ApiRequestHandler<{[endpoint: string]: IApiEndpoint<any>}>;
}

export function readAppConfig$(options: IAppConfigOptions): Observable<IAppConfig> {
    // Read the version of the BroikerKit itself
    const { version } = require('../package.json');
    const { stage, appConfigPath, debug } = options;
    const appConfig$ = readConfig$<any>(appConfigPath);
    const projectRoot = path.dirname(appConfigPath);
    return appConfig$
        .map((appConfig) => {
            const {stages, ...siteConfig} = appConfig;
            const stageConfig = stages[stage];
            const buildDir = path.join('./.broiler/build', stage || 'local');
            const stackName = `${siteConfig.name}-${stage}`;
            return {
                ...siteConfig,
                ...stageConfig,
                debug,
                projectRoot,
                buildDir,
                stage,
                stackName,
            };
        })
        // Read any API config
        .switchMap((config) => {
            // No api defined?
            if (!config.apiPath) {
                return [config];
            }
            return readConfig$<any>(config.apiPath)
                .map((api) => ({...config, api}))
            ;
        })
        .map((config) => {
            const requiredVersion = config.broilerKitVersion;
            if (semver.satisfies(version, requiredVersion)) {
                return config;
            }
            throw new Error(`The app requires BroilerKit version ${requiredVersion} but the currently used version is ${version}!`);
        })
    ;
}
