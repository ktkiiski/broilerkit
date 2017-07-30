import { Observable } from 'rxjs';
import * as webpack from 'webpack';
import { clean } from './clean';
import { readConfig$ } from './utils';

export interface ICompileOptions {
    buildDir: string;
    webpackConfigPath: string;
    devServer: boolean;
    baseUrl: string;
    iconFile: string;
    debug: boolean;
}

type IWebpackConfigFactory = (options: ICompileOptions) => webpack.Configuration;

export function compile(options: ICompileOptions): Observable<webpack.Stats> {
    return readConfig$<IWebpackConfigFactory>(options.webpackConfigPath)
        .combineLatest(clean(options.buildDir).last(), (config) => config)
        .map((createWebpackConfig) => createWebpackConfig(options))
        .map(webpack)
        .map((compiler) => compiler.run.bind(compiler) as typeof compiler.run)
        .switchMap((run) => Observable.bindNodeCallback(run)())
        .switchMap((stats) => {
            if (stats.hasErrors()) {
                return Observable.throw(Object.assign(
                    new Error(stats.toString('errors-only')),
                    {stats},
                ));
            }
            return Observable.of(stats);
        })
    ;
}
