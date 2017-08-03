import { Observable } from 'rxjs';
import { URL } from 'url';
import * as webpack from 'webpack';
import * as WebpackDevServer from 'webpack-dev-server';
import { ICompileOptions, IWebpackConfigFactory } from './compile';
import { readConfig$ } from './utils';

/**
 * Runs the Webpack development server.
 */
export function serve$(options: ICompileOptions): Observable<ICompileOptions> {
    const baseUrl = options.baseUrl;
    const baseUrlObj = new URL(baseUrl);
    const serverHostName = baseUrlObj.hostname;
    const serverPort = parseInt(baseUrlObj.port, 10);
    // TODO: Is this configuration for the inline livereloading still required?
    // https://webpack.github.io/docs/webpack-dev-server.html#inline-mode-with-node-js-api
    return readConfig$<IWebpackConfigFactory>(options.webpackConfigPath)
        .map((createWebpackConfig) => createWebpackConfig({...options, devServer: true}))
        .map((config) => webpack(config))
        .map((compiler) => new WebpackDevServer(compiler, {
            stats: {
                colors: true,
            },
            watchOptions: {
                poll: 1000,
            },
            publicPath: '/',
        } as WebpackDevServer.Configuration))
        .switchMap((devServer) => new Observable((subscriber) => {
            const server = devServer.listen(serverPort, serverHostName, (error) => {
                if (error) {
                    subscriber.error(error);
                } else {
                    subscriber.next(options);
                }
            });
            server.on('close', () => subscriber.complete());
            server.on('error', (error) => subscriber.error(error));
        }))
    ;
}
