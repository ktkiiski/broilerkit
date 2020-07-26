import * as webpack from 'webpack';
import { generate } from './async';

export function compile(configs: webpack.Configuration[]): Promise<webpack.compilation.MultiStats> {
    const compiler = webpack(configs);
    return new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            if (error || !stats) {
                reject(error || stats);
            } else if (stats.hasErrors()) {
                reject(Object.assign(new Error(stats.toString('errors-only')), { stats }));
            } else {
                resolve(stats);
            }
        });
    });
}

export function watch(config: webpack.Configuration): AsyncIterableIterator<webpack.Stats> {
    return generate(({ next, error }) => {
        const compiler = webpack(config);
        const watching = compiler.watch(
            {
                aggregateTimeout: 300,
                poll: 5000,
            },
            (err, stats) => {
                if (err) {
                    error(err);
                } else {
                    // NOTE: There may still be compilation errors
                    next(stats);
                }
            },
        );
        return () => watching.close(() => undefined);
    });
}
