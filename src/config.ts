import { Observable } from 'rxjs';
import * as semver from 'semver';
import { readConfig$ } from './utils/fs';

export interface IAppConfigOptions {
    appConfigPath: string;
    stage: string;
    tsconfigPath: string;
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
    const tsconfig$ = readConfig$<any>(options.tsconfigPath);
    const appConfig$ = readConfig$<any>(options.appConfigPath);
    const appStageConfig$ = appConfig$.map((appConfig) => {
        const {stages, ...siteConfig} = appConfig;
        const stageConfig = stages[options.stage];
        return {
            ...siteConfig,
            ...stageConfig,
            stage: options.stage,
            stackName: `${siteConfig.appName}-${options.stage}`,
        };
    });
    return Observable.combineLatest(
        tsconfig$,
        appStageConfig$,
        (tsconfig, appStageConfig) => ({
            ...options,
            ...appStageConfig,
            buildDir: tsconfig.compilerOptions.outDir,
        }),
    ).map((config) => {
        const requiredVersion = config.broilerKitVersion;
        if (semver.satisfies(version, requiredVersion)) {
            return config;
        }
        throw new Error(`The app requires BroilerKit version ${requiredVersion} but the currently used version is ${version}!`);
    });
}
