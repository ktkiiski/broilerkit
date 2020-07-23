/* eslint-disable @typescript-eslint/no-var-requires */
import * as path from 'path';
import * as url from 'url';
import * as webpack from 'webpack';

import { BroilerConfig } from './config';
import { executeSync } from './exec';

// Webpack plugins
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const WebappWebpackPlugin = require('webapp-webpack-plugin');
const HtmlWebpackHarddiskPlugin = require('html-webpack-harddisk-plugin');

export interface WebpackConfigOptions extends BroilerConfig {
    devServer: boolean;
    analyze: boolean;
}

/**
 * Creates the Webpack 2 configuration for the front-end asset compilation.
 * The options are documented at
 * https://webpack.js.org/configuration/
 */
export function getFrontendWebpackConfig(config: WebpackConfigOptions): webpack.Configuration {
    const {
        devServer,
        debug,
        iconFile,
        sourceDir,
        buildDir,
        stageDir,
        title,
        siteFile,
        projectRootPath,
        analyze,
    } = config;
    const { assetsRoot, serverRoot } = config;
    // Resolve modules, source, build and static paths
    const sourceDirPath = path.resolve(projectRootPath, sourceDir);
    const stageDirPath = path.resolve(projectRootPath, stageDir);
    const buildDirPath = path.resolve(projectRootPath, buildDir);
    const modulesDirPath = path.resolve(projectRootPath, 'node_modules');
    const ownModulesDirPath = path.resolve(__dirname, 'node_modules');
    const tsConfigPath = path.resolve(projectRootPath, './tsconfig.json');
    // Determine the directory for the assets and the site
    const assetsRootUrl = url.parse(assetsRoot);
    const assetsPath = assetsRootUrl.pathname || '/';
    const assetsDir = assetsPath.replace(/^\/+/, '');
    const assetsFilePrefix = assetsDir && assetsDir + '/';
    const assetsOrigin = `${assetsRootUrl.protocol}//${assetsRootUrl.host}`;
    const gitCommitHash = executeSync('git rev-parse HEAD');
    const gitVersion = executeSync('git describe --always --dirty="-$(git diff-tree HEAD | md5 -q | head -c 8)"');
    const gitBranch = executeSync('git rev-parse --abbrev-ref HEAD');
    // Generate the plugins
    const plugins: webpack.Plugin[] = [
        // Perform type checking for TypeScript
        new ForkTsCheckerWebpackPlugin({
            typescript: {
                // Use the tsconfig.json in the project folder (not in this library)
                configFile: tsConfigPath,
            },
            eslint: {
                files: path.join(sourceDirPath, '**', '*.{ts,tsx,js,jsx}'),
            },
        }),
        // Create HTML plugins for each webpage
        new HtmlWebpackPlugin({
            title,
            filename: devServer ? 'index.html' : 'index.[hash].html',
            template: path.resolve(__dirname, './res/index.html'),
            chunks: ['app'],
            // Insert tags for stylesheets and scripts
            inject: 'body',
            // No cache-busting needed, because hash is included in file names
            hash: false,
            // Force-write the file to file system to make it available for SSR
            alwaysWriteToDisk: devServer,
        }),
        /**
         * Provide polyfills with ProvidePlugin.
         */
        new webpack.ProvidePlugin({
            Promise: [require.resolve('./polyfill/promise'), 'Promise'],
            Symbol: [require.resolve('./polyfill/symbol'), 'Symbol'],
        }),
        /**
         * Replace "global variables" from the scripts with the constant values.
         */
        new webpack.DefinePlugin({
            // Allow using the GIT commit hash ID
            __COMMIT_HASH__: JSON.stringify(gitCommitHash),
            // Allow using the GIT version
            __VERSION__: JSON.stringify(gitVersion),
            // Allow using the GIT branch name
            __BRANCH__: JSON.stringify(gitBranch),
        }),
        /**
         * Prevent all the MomentJS locales to be imported by default.
         */
        new webpack.ContextReplacementPlugin(
            /\bmoment[/\\]locale\b/,
            // Regular expression to match the files that should be imported
            /\ben.js/,
        ),
    ];
    if (!devServer) {
        plugins.push(
            // Extract stylesheets to separate files in production
            new MiniCssExtractPlugin({
                filename: devServer ? `${assetsFilePrefix}[name].css` : `${assetsFilePrefix}[name].[contenthash].css`,
            }),
            // Generate some stats for the bundles
            getBundleAnalyzerPlugin(analyze, path.resolve(stageDirPath, `report-frontend.html`)),
        );
    }
    // Define the entry for the app
    const entries: Record<string, string[]> = {
        app: [require.resolve(devServer ? './bootstrap/local-site' : './bootstrap/site')],
    };
    /**
     * If icon source file is provided, generate icons for the app.
     * For configuration, see https://github.com/jantimon/favicons-webpack-plugin
     */
    if (iconFile) {
        plugins.push(
            new WebappWebpackPlugin({
                // Your source logo
                logo: path.resolve(sourceDirPath, iconFile),
                // The prefix for all image files (might be a folder or a name)
                prefix: devServer ? `${assetsFilePrefix}icons/` : `${assetsFilePrefix}icons/[hash]/`,
                // Emit all stats of the generated icons
                emitStats: true,
                // Generate a cache file with control hashes and
                // don't rebuild the favicons until those hashes change
                persistentCache: true,
                // Inject the html into the html-webpack-plugin
                inject: true,
                // Locate the cache folder inside the .broiler directory
                cache: path.resolve(stageDirPath, '.wwp-cache'),
                // The configuration for `favicon`:
                // https://github.com/itgalaxy/favicons#usage
                favicon: {
                    // Start URL when launching the application from a device. `string`
                    start_url: serverRoot,
                    // NOTE The most of the metadata is read automatically from package.json
                },
                /**
                 * Which icons should be generated.
                 * See: https://github.com/haydenbleasel/favicons#usage
                 * Platform Options:
                 * - offset - offset in percentage
                 * - shadow - drop shadow for Android icons, available online only
                 * - background:
                 *   * false - use default
                 *   * true - force use default, e.g. set background for Android icons
                 *   * color - set background for the specified icons
                 */
                icons: {
                    // Create Android homescreen icon. `boolean` or `{ offset, background, shadow }`
                    android: !devServer && !debug,
                    // Create Apple touch icons. `boolean` or `{ offset, background }`
                    appleIcon: !devServer && !debug,
                    // Create Apple startup images. `boolean` or `{ offset, background }`
                    appleStartup: !devServer && !debug,
                    // Create Opera Coast icon with offset 25%. `boolean` or `{ offset, background }`
                    coast: false,
                    // Create regular favicons. `boolean`
                    favicons: true,
                    // Create Firefox OS icons. `boolean` or `{ offset, background }`
                    firefox: false,
                    // Create Windows 8 tile icons. `boolean` or `{ background }`
                    windows: !devServer && !debug,
                    // Create Yandex browser icon. `boolean` or `{ background }`
                    yandex: false,
                },
            }),
        );
    }
    // Add support for `alwaysWriteToDisk` option
    plugins.push(new HtmlWebpackHarddiskPlugin());
    return {
        context: projectRootPath,
        // Development or production build?
        mode: devServer || debug ? 'development' : 'production',
        // The main entry points for source files.
        entry: entries,
        // Supposed to run in a browser
        target: 'web',

        output: {
            // Output files are placed to this folder
            path: buildDirPath,
            // The file name template for the entry chunks
            filename: devServer ? `${assetsFilePrefix}[name].js` : `${assetsFilePrefix}[name].[chunkhash].js`,
            // The URL to the output directory resolved relative to the HTML page
            // This will be the origin, not including the path, because that will be used as a subdirectory for files.
            publicPath: `${assetsOrigin}/`,
            // The name of the exported library, e.g. the global variable name
            library: 'app',
            // How the library is exported? E.g. 'var', 'this'
            libraryTarget: 'var',
        },

        module: {
            rules: [
                // Pre-process sourcemaps for scripts
                {
                    test: /\.(jsx?|tsx?)$/,
                    loader: 'source-map-loader',
                    enforce: 'pre',
                },
                // Compile TypeScript files ('.ts' or '.tsx')
                {
                    test: /\.tsx?$/,
                    loader: 'ts-loader',
                    options: {
                        // Explicitly expect the tsconfig.json to be located at the project root
                        configFile: tsConfigPath,
                        // Disable type checker - use `fork-ts-checker-webpack-plugin` for that purpose instead
                        transpileOnly: true,
                    },
                },
                // Extract CSS stylesheets from the main bundle
                {
                    test: /\.(css|scss)($|\?)/,
                    sideEffects: true,
                    use: [
                        // For production extract to a separate CSS file
                        devServer || debug ? 'style-loader' : MiniCssExtractPlugin.loader,
                        {
                            loader: 'css-loader',
                            options: {
                                // For production, compress the CSS
                                minimize: !devServer && !debug,
                                sourceMap: devServer || debug,
                                url: true,
                                import: true,
                            },
                        },
                    ],
                },
                // Optimize image files and bundle them as files or data URIs
                {
                    test: /\.(gif|png|jpe?g|svg)$/,
                    use: [
                        {
                            loader: 'url-loader',
                            options: {
                                // Max bytes to be converted to inline data URI
                                limit: 100,
                                // If larger, then convert to a file instead
                                name: `${assetsFilePrefix}images/[name].[hash].[ext]`,
                            },
                        },
                        {
                            loader: 'image-webpack-loader',
                            options: {
                                disable: debug || devServer,
                                optipng: {
                                    optimizationLevel: 7,
                                },
                            },
                        },
                    ],
                },
                // Include font files either as data URIs or separate files
                {
                    test: /\.(eot|ttf|otf|woff2?|svg)($|\?|#)/,
                    loader: 'url-loader',
                    options: {
                        // Max bytes to be converted to inline data URI
                        limit: 100,
                        // If larger, then convert to a file instead
                        name: `${assetsFilePrefix}fonts/[name].[hash].[ext]`,
                    },
                },
            ],
        },

        resolve: {
            // Add '.ts' and '.tsx' as resolvable extensions.
            extensions: ['.ts', '.tsx', '.js'],
            alias: {
                // The entry point will `require` this module for finding the website component
                _site: path.resolve(projectRootPath, sourceDir, siteFile),
            },
        },

        resolveLoader: {
            // Look from this library's node modules!
            modules: [ownModulesDirPath, modulesDirPath],
        },

        // Behavior for polyfilling node modules
        node: {
            // The default value `true` seems not to work with RxJS
            // TODO: Take a look if this can be enabled
            setImmediate: false,
        },

        // Enable sourcemaps for debugging webpack's output.
        devtool: devServer ? 'inline-source-map' : 'source-map',

        // Plugins
        plugins,
    };
}
/**
 * Creates the Webpack 2 configuration for the back-end code compilation.
 * The options are documented at
 * https://webpack.js.org/configuration/
 */
export function getBackendWebpackConfig(config: WebpackConfigOptions): webpack.Configuration {
    const { serverFile, databaseFile, siteFile, triggersFile } = config;
    const { sourceDir, buildDir, projectRootPath, devServer, debug, assetsRoot } = config;
    const { analyze, stageDir } = config;
    // Resolve modules, source, build and static paths
    const sourceDirPath = path.resolve(projectRootPath, sourceDir);
    const buildDirPath = path.resolve(projectRootPath, buildDir);
    const modulesDirPath = path.resolve(projectRootPath, 'node_modules');
    const ownModulesDirPath = path.resolve(__dirname, 'node_modules');
    const stageDirPath = path.resolve(projectRootPath, stageDir);
    // Use the tsconfig.json in the project folder (not in this library)
    const tsConfigPath = path.resolve(projectRootPath, './tsconfig.json');
    // Target backend always to ES2018
    const compilerOptions = { target: 'ES2017' } as const;

    // Generate the plugins
    const plugins: webpack.Plugin[] = [
        // Perform type checking for TypeScript
        new ForkTsCheckerWebpackPlugin({
            typescript: {
                configFile: tsConfigPath,
                configOverwrite: {
                    compilerOptions,
                },
            },
            eslint: {
                files: path.join(sourceDirPath, '**', '*.{ts,tsx,js,jsx}'),
            },
        }),
        /**
         * Prevent all the MomentJS locales to be imported by default.
         */
        new webpack.ContextReplacementPlugin(
            /\bmoment[/\\]locale\b/,
            // Regular expression to match the files that should be imported
            /\ben.js/,
        ),
        /**
         * Prevent `pg` module to import `pg-native` binding library.
         */
        new webpack.IgnorePlugin({
            resourceRegExp: /^\.\/native$/,
            contextRegExp: /node_modules\/pg\/lib$/,
        }),
    ];
    if (!devServer) {
        // Generate some stats for the bundles
        plugins.push(getBundleAnalyzerPlugin(analyze, path.resolve(stageDirPath, `report-backend.html`)));
    }
    // Entry points to be bundled
    const entries: Record<string, string> = {
        // Entry point for rendering the views on server-side
        server: require.resolve(devServer ? './bootstrap/local-server' : './bootstrap/server'),
    };
    // Aliases that entry points will `require`
    const aliases: Record<string, string> = {
        _site: path.resolve(projectRootPath, sourceDir, siteFile),
    };
    // Modules excluded from the bundle
    const externals = [
        // No need to bundle AWS SDK for compilation, because it will be available in the Lambda node environment
        'aws-sdk',
    ];
    // If an API is defined, compile it as well
    if (serverFile) {
        aliases._service = path.resolve(projectRootPath, sourceDir, serverFile);
    } else {
        // API not available. Let the bundle to compile without it, but
        // raise error if attempting to `require`
        externals.push('_service');
    }
    // If a database defined, compile it as well
    if (databaseFile) {
        aliases._db = path.resolve(projectRootPath, sourceDir, databaseFile);
    } else {
        // Database not available. Let the bundle to compile without it, but
        // raise error if attempting to `require`
        externals.push('_db');
    }
    // If a triggers file is defined, compile it as well
    if (triggersFile) {
        aliases._triggers = path.resolve(projectRootPath, sourceDir, triggersFile);
    } else {
        // Triggers not available. Let the bundle to compile without it, but
        // raise error if attempting to `require`
        externals.push('_triggers');
    }

    return {
        context: projectRootPath,
        // Development or production build?
        mode: devServer || debug ? 'development' : 'production',

        optimization: {
            // For better tracebacks, do not minify server-side code,
            // even in production.
            minimize: false,
        },

        // Build for running in node environment, instead of web browser
        target: 'node',

        // The main entry points for source files.
        entry: entries,

        output: {
            // Output files are placed to this folder
            path: buildDirPath,
            // The file name template for the entry chunks
            filename: devServer ? '[name].js' : '[name].[hash].js',
            // The URL to the output directory resolved relative to the HTML page
            publicPath: `${assetsRoot}/`,
            // Export so for use in a Lambda function
            libraryTarget: 'commonjs2',
        },

        module: {
            rules: [
                // Pre-process sourcemaps for scripts
                {
                    test: /\.(jsx?|tsx?)$/,
                    loader: 'source-map-loader',
                    enforce: 'pre',
                },
                // Compile TypeScript files ('.ts' or '.tsx')
                {
                    test: /\.tsx?$/,
                    loader: 'ts-loader',
                    options: {
                        // Explicitly expect the tsconfig.json to be located at the project root
                        configFile: tsConfigPath,
                        // Disable type checker - use `fork-ts-checker-webpack-plugin` for that purpose instead
                        transpileOnly: true,
                        compilerOptions,
                    },
                },
            ],
        },

        externals,

        resolve: {
            // Add '.ts' and '.tsx' as resolvable extensions.
            extensions: ['.ts', '.tsx', '.js'],
            alias: aliases,
        },

        resolveLoader: {
            // Look from this library's node modules!
            modules: [ownModulesDirPath, modulesDirPath],
        },

        // Enable sourcemaps for debugging webpack's output.
        devtool: 'source-map',

        // Plugins
        plugins,
    };
}

function getBundleAnalyzerPlugin(enabled: boolean, filename: string) {
    return new BundleAnalyzerPlugin({
        // Can be `server`, `static` or `disabled`.
        // In `server` mode analyzer will start HTTP server to show bundle report.
        // In `static` mode single HTML file with bundle report will be generated.
        // In `disabled` mode you can use this plugin to just generate Webpack Stats JSON file by setting `generateStatsFile` to `true`.
        analyzerMode: enabled ? 'static' : 'disabled',
        // Host that will be used in `server` mode to start HTTP server.
        analyzerHost: '127.0.0.1',
        // Port that will be used in `server` mode to start HTTP server.
        analyzerPort: 8888,
        // Path to bundle report file that will be generated in `static` mode.
        // Relative to bundles output directory.
        reportFilename: filename,
        // Module sizes to show in report by default.
        // Should be one of `stat`, `parsed` or `gzip`.
        // See "Definitions" section for more information.
        defaultSizes: 'parsed',
        // Automatically open report in default browser
        openAnalyzer: enabled,
        // If `true`, Webpack Stats JSON file will be generated in bundles output directory
        generateStatsFile: false,
        // Name of Webpack Stats JSON file that will be generated if `generateStatsFile` is `true`.
        // Relative to bundles output directory.
        statsFilename: 'stats.json',
        // Options for `stats.toJson()` method.
        // For example you can exclude sources of your modules from stats file with `source: false` option.
        // See more options here: https://github.com/webpack/webpack/blob/webpack-1/lib/Stats.js#L21
        statsOptions: null,
        // Log level. Can be 'info', 'warn', 'error' or 'silent'.
        logLevel: 'info',
    });
}
