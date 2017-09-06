import { Observable } from 'rxjs';
import * as webpack from 'webpack';

export function compile$(config: webpack.Configuration): Observable<webpack.Stats> {
    const compiler = webpack(config);
    const run = compiler.run.bind(compiler) as typeof compiler.run;
    return Observable.bindNodeCallback(run)()
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
