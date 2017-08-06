import * as path from 'path';
import { Observable } from 'rxjs';
import * as semver from 'semver';
import { readConfig$ } from './utils/fs';

export interface IAppConfigOptions {
    appConfigPath: string;
    stage: string;
}

export interface IAppConfig extends IAppConfigOptions {
    appName: string;
    broilerKitVersion: string;
    assetsDomain: string;
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
    siteDomain: string;
    sourceDir: string;
    stackName: string;
}

export interface IAppCompileOptions extends IAppConfig {
    baseUrl: string;
}

export function readAppConfig$(options: IAppConfigOptions): Observable<IAppConfig> {
    // Read the version of the BroikerKit itself
    const { version } = require('../package.json');
    const { stage, appConfigPath } = options;
    const appConfig$ = readConfig$<any>(appConfigPath);
    const projectRoot = path.dirname(appConfigPath);
    return appConfig$
        .map((appConfig) => {
            const {stages, ...siteConfig} = appConfig;
            const stageConfig = stages[stage];
            const buildDir = path.join('./.broiler/build', stage || 'local');
            const stackName = `${siteConfig.appName}-${stage}`;
            return {
                ...siteConfig,
                ...stageConfig,
                projectRoot,
                buildDir,
                stage,
                stackName,
            };
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
