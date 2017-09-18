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

export function watch$(config: webpack.Configuration): Observable<webpack.Stats> {
    const compiler = webpack(config);
    return new Observable<webpack.Stats>((subscriber) => {
        const watching = compiler.watch({
            aggregateTimeout: 300,
            poll: 5000,
        }, (error, stats) => {
            if (error) {
                subscriber.error(error);
            } else {
                // NOTE: There may still be compilation errors
                subscriber.next(stats);
            }
        });
        return () => watching.close(() => undefined);
    });
}
