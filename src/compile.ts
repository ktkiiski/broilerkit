import { Observable } from 'rxjs';
import * as webpack from 'webpack';
import { clean } from './clean';
import { readConfig$ } from './utils';

export interface ICompileOptions {
    buildDir: string;
    webpackConfigPath: string;
    baseUrl: string;
    iconFile: string;
    debug: boolean;
}

export type IWebpackConfigFactory = (options: ICompileOptions & {devServer: boolean}) => webpack.Configuration;

export function compile(options: ICompileOptions): Observable<webpack.Stats> {
    return readConfig$<IWebpackConfigFactory>(options.webpackConfigPath)
        .combineLatest(clean(options.buildDir).last(), (config) => config)
        .map((createWebpackConfig) => createWebpackConfig({...options, devServer: false}))
        .map((config) => webpack(config))
        .map((compiler) => compiler.run.bind(compiler) as typeof compiler.run)
        .switchMap((run) => Observable.bindNodeCallback(run)())
        .map((stats) => {
            if (stats.hasErrors()) {
                throw Object.assign(
                    new Error(stats.toString('errors-only')),
                    {stats},
                );
            }
            return stats;
        })
    ;
}
