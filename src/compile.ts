import { Observable } from 'rxjs';
import * as webpack from 'webpack';
import { clean$ } from './clean';
import { IAppConfig } from './config';
import { getWebpackConfig } from './webpack';

export function compile$(options: IAppConfig): Observable<webpack.Stats> {
    return clean$(options.buildDir)
        .map(() => getWebpackConfig({...options, devServer: false}))
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
