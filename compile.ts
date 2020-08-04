import * as webpack from 'webpack';

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
