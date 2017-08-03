import { Observable } from 'rxjs';
import { readConfig$ } from './utils/fs';

export interface IAppConfigOptions {
    appConfigPath: string;
    stage: string;
    tsconfigPath: string;
    webpackConfigPath: string;
}

export interface IAppConfig extends IAppConfigOptions {
    appName: string;
    assetsDomain: string;
    buildDir: string;
    debug: boolean;
    iconFile: string;
    region: string;
    siteDomain: string;
    stackName: string;
}

export function readAppConfig$(options: IAppConfigOptions): Observable<IAppConfig> {
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
    );
}
