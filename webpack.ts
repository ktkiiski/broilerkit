import * as path from 'path';
import * as webpack from 'webpack';

import { AuthOptions } from './auth';
import { BroilerConfig } from './config';
import { executeSync } from './exec';
import { union } from './utils/arrays';
import { buildObject, pick } from './utils/objects';

// Webpack plugins
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
const ExtractTextPlugin = require('extract-text-webpack-plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const WebappWebpackPlugin = require('webapp-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

export interface WebpackConfigOptions extends BroilerConfig {
    devServer: boolean;
    analyze: boolean;
}

export interface WebpackFrontendConfigOptions extends WebpackConfigOptions {
    authClientId: string;
    authRoot: string;
}

/**
 * Creates the Webpack 2 configuration for the front-end asset compilation.
 * The options are documented at
 * https://webpack.js.org/configuration/
 */
export function getFrontendWebpackConfig(config: WebpackFrontendConfigOptions): webpack.Configuration {
    const {devServer, debug, iconFile, sourceDir, buildDir, stageDir, pages, projectRootPath, stage, analyze} = config;
    const {region, apiRoot, assetsRoot, siteRoot, authClientId, authRoot} = config;
    // Resolve modules, source, build and static paths
    const sourceDirPath = path.resolve(projectRootPath, sourceDir);
    const stageDirPath = path.resolve(projectRootPath, stageDir);
    const scriptPaths = union(...pages.map((page) => page.scripts));
    const buildDirPath = path.resolve(projectRootPath, buildDir);
    const modulesDirPath = path.resolve(projectRootPath, 'node_modules');
    const ownModulesDirPath = path.resolve(__dirname, 'node_modules');
    // Determine options for the AuthClient
    const authOptions: AuthOptions = {
        clientId: authClientId,
        signInUri: devServer ? `${authRoot}/_oauth2_signin.html` : `${authRoot}/oauth2/authorize`,
        signOutUri: devServer ? `${authRoot}/_oauth2_signout.html` : `${authRoot}/logout`,
        signInRedirectUri: `${siteRoot}/_oauth2_signin_complete.html`,
        signOutRedirectUri: `${siteRoot}/_oauth2_signout_complete.html`,
    };
    const gitCommitHash = executeSync('git rev-parse HEAD');
    const gitVersion = executeSync('git describe --always --dirty="-$(git diff-tree HEAD | md5 -q | head -c 8)"');
    const gitBranch = executeSync('git rev-parse --abbrev-ref HEAD');
    // Generate the plugins
    const plugins: webpack.Plugin[] = [
        // Perform type checking for TypeScript
        new ForkTsCheckerWebpackPlugin({
            // Synchronize with the main Webpack compilation, causing it to fail if there are type errors
            async: false,
            // Do not log anything. Any failure will become visible anyway
            silent: true,
            // Use the tsconfig.json in the project folder (not in this library)
            tsconfig: path.resolve(projectRootPath, './tsconfig.json'),
            // Use the tslint.json in the project folder (not in this library)
            tslint: path.resolve(projectRootPath, './tslint.json'),
        }),
        // Extract stylesheets to separate files in production
        new ExtractTextPlugin({
            disable: devServer,
            filename: devServer && debug ? '[name].css' : '[name].[hash].css',
        }),
        // Create HTML plugins for each webpage
        ...pages.map(
            ({file, title, scripts}) => new HtmlWebpackPlugin({
                title,
                filename: path.format({...pick(path.parse(file), ['dir', 'name']), ext: '.html'}),
                template: path.resolve(sourceDirPath, file),
                chunks: scripts.map((name) => path.basename(name).replace(/\..*?$/, '')),
                // Insert tags for stylesheets and scripts
                inject: true,
                // No cache-busting needed, because hash is included in file names
                hash: false,
            }),
        ),
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
            // This will strip out development features from React when building for production
            'process.env': {
                NODE_ENV: JSON.stringify(debug ? 'development' : 'production'),
            },
            // Static assets URL root
            '__ASSETS_ROOT__': JSON.stringify(assetsRoot),
            // Web site URL root
            '__SITE_ROOT__': JSON.stringify(siteRoot),
            // API URL root
            '__API_ROOT__': JSON.stringify(apiRoot),
            // Allow using the GIT commit hash ID
            '__COMMIT_HASH__': JSON.stringify(gitCommitHash),
            // Allow using the GIT version
            '__VERSION__': JSON.stringify(gitVersion),
            // Allow using the GIT branch name
            '__BRANCH__': JSON.stringify(gitBranch),
            // AWS region to which the app is deployed
            '__AWS_REGION__': JSON.stringify(region),
            // Options for the authentication client
            '__AUTH_OPTIONS__': JSON.stringify(authOptions),
        }),
        /**
         * Prevent all the MomentJS locales to be imported by default.
         */
        new webpack.ContextReplacementPlugin(
            /\bmoment[\/\\]locale\b/,
            // Regular expression to match the files that should be imported
            /\ben.js/,
        ),
        /**
         * Generate some stats for the bundles.
         */
        new BundleAnalyzerPlugin({
            // Can be `server`, `static` or `disabled`.
            // In `server` mode analyzer will start HTTP server to show bundle report.
            // In `static` mode single HTML file with bundle report will be generated.
            // In `disabled` mode you can use this plugin to just generate Webpack Stats JSON file by setting `generateStatsFile` to `true`.
            analyzerMode: analyze ? 'static' : 'disabled',
            // Host that will be used in `server` mode to start HTTP server.
            analyzerHost: '127.0.0.1',
            // Port that will be used in `server` mode to start HTTP server.
            analyzerPort: 8888,
            // Path to bundle report file that will be generated in `static` mode.
            // Relative to bundles output directory.
            reportFilename: `../report-${stage}.html`,
            // Module sizes to show in report by default.
            // Should be one of `stat`, `parsed` or `gzip`.
            // See "Definitions" section for more information.
            defaultSizes: 'parsed',
            // Automatically open report in default browser
            openAnalyzer: analyze,
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
        }),
    ];
    // If running the development server, then add the dummy OAuth2 service
    if (devServer) {
        scriptPaths.push(
            path.resolve(__dirname, `./res/_oauth2_signin.ts`),
            path.resolve(__dirname, `./res/_oauth2_signout.ts`),
        );
        plugins.push(
            new HtmlWebpackPlugin({
                title: 'Sign in',
                filename: '_oauth2_signin.html',
                template: path.resolve(__dirname, `./res/_oauth2_signin.html`),
                chunks: ['_oauth2_signin'],
                inject: true,
                hash: false,
            }),
            new HtmlWebpackPlugin({
                title: 'Sign out',
                filename: '_oauth2_signout.html',
                template: path.resolve(__dirname, `./res/_oauth2_signout.html`),
                chunks: ['_oauth2_signout'],
                inject: true,
                hash: false,
            }),
            new HtmlWebpackPlugin({
                filename: '_oauth2_signin_complete.html',
                template: path.resolve(__dirname, `./res/_oauth2_signin_complete.html`),
                chunks: [],
                inject: false,
                hash: false,
            }),
            new HtmlWebpackPlugin({
                filename: '_oauth2_signout_complete.html',
                template: path.resolve(__dirname, `./res/_oauth2_signout_complete.html`),
                chunks: [],
                inject: false,
                hash: false,
            }),
        );
    }
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
                prefix: devServer && debug ? 'icons/' : 'icons/[hash]/',
                // Emit all stats of the generated icons
                emitStats: true,
                // Generate a cache file with control hashes and
                // don't rebuild the favicons until those hashes change
                persistentCache: true,
                // Inject the html into the html-webpack-plugin
                inject: true,
                // Locate the cache folder inside the .broiler directory
                cache: path.resolve(stageDirPath, '.wwp-cache'),
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
                    android: !debug,
                    // Create Apple touch icons. `boolean` or `{ offset, background }`
                    appleIcon: !debug,
                    // Create Apple startup images. `boolean` or `{ offset, background }`
                    appleStartup: !debug,
                    // Create Opera Coast icon with offset 25%. `boolean` or `{ offset, background }`
                    coast: false,
                    // Create regular favicons. `boolean`
                    favicons: true,
                    // Create Firefox OS icons. `boolean` or `{ offset, background }`
                    firefox: false,
                    // Create Windows 8 tile icons. `boolean` or `{ background }`
                    windows: !debug,
                    // Create Yandex browser icon. `boolean` or `{ background }`
                    yandex: false,
                },
            }),
        );
    }
    // If building for the production, minimize the JavaScript
    if (!debug) {
        plugins.push(
            new webpack.optimize.UglifyJsPlugin({
                compress: {
                    warnings: false,
                },
            }),
        );
    }
    return {
        // The main entry points for source files.
        entry: buildObject(scriptPaths, (entry) => [
            path.basename(entry).replace(/\..*?$/, ''),
            path.resolve(sourceDirPath, entry),
        ]),

        output: {
            // Output files are placed to this folder
            path: buildDirPath,
            // The file name template for the entry chunks
            filename: devServer && debug ? '[name].js' : '[name].[chunkhash].js',
            // The URL to the output directory resolved relative to the HTML page
            publicPath: `${assetsRoot}/`,
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
                // Lint JavaScript files using eslint
                {
                    test: /\.jsx?$/,
                    include: sourceDirPath,
                    loader: 'eslint-loader',
                    enforce: 'pre',
                    options: {
                        cache: true,
                        failOnError: true, // Fail the build if there are linting errors
                        failOnWarning: false, // Do not fail the build on linting warnings
                        fix: true, // Auto-fix if possible
                    },
                },
                // Compile TypeScript files ('.ts' or '.tsx')
                {
                    test: /\.tsx?$/,
                    loader: 'ts-loader',
                    options: {
                        // Explicitly expect the tsconfig.json to be located at the project root
                        configFile: path.resolve(projectRootPath, './tsconfig.json'),
                        // Disable type checker - use `fork-ts-checker-webpack-plugin` for that purpose instead
                        transpileOnly: true,
                    },
                },
                // Extract CSS stylesheets from the main bundle
                {
                    test: /\.(css|scss)($|\?)/,
                    loader: ExtractTextPlugin.extract({
                        use: [{
                            loader: 'css-loader',
                            options: {
                                // For production, compress the CSS
                                minimize: !debug,
                                sourceMap: debug,
                                url: true,
                                import: true,
                            },
                        }],
                        fallback: 'style-loader',
                    }),
                },
                // Compile SASS files ('.scss')
                {
                    test: /\.scss($|\?)/,
                    loader: 'fast-sass-loader',
                },
                // Convert any Pug (previously 'Jade') templates to HTML
                {
                    test: /\.pug$/,
                    loader: 'pug-loader',
                    options: {
                        pretty: debug,
                    },
                },
                // Ensure that any images references in HTML files are included
                {
                    test: /\.(md|markdown|html?|tmpl)$/,
                    loader: 'html-loader',
                    options: {
                        attrs: ['img:src', 'link:href'],
                    },
                },
                // Convert any Markdown files to HTML, and require any referred images/stylesheet
                {
                    test: /\.(md|markdown)$/,
                    loader: 'markdown-loader',
                },
                // Optimize image files and bundle them as files or data URIs
                {
                    test: /\.(gif|png|jpe?g|svg)$/,
                    use: [{
                        loader: 'url-loader',
                        options: {
                            // Max bytes to be converted to inline data URI
                            limit: 100,
                            // If larger, then convert to a file instead
                            name: 'images/[name].[hash].[ext]',
                        },
                    }, {
                        loader: 'image-webpack-loader',
                        options: {
                            progressive: true,
                            optipng: {
                                optimizationLevel: debug ? 0 : 7,
                            },
                        },
                    }],
                },
                // Include font files either as data URIs or separate files
                {
                    test: /\.(eot|ttf|otf|woff2?|svg)($|\?|#)/,
                    loader: 'url-loader',
                    options: {
                        // Max bytes to be converted to inline data URI
                        limit: 100,
                        // If larger, then convert to a file instead
                        name: 'fonts/[name].[hash].[ext]',
                    },
                },
            ],
        },

        resolve: {
            // Add '.ts' and '.tsx' as resolvable extensions.
            extensions: ['.ts', '.tsx', '.js'],
        },

        resolveLoader: {
            // Look from this library's node modules!
            modules: [
                ownModulesDirPath,
                modulesDirPath,
            ],
        },

        // Behavior for polyfilling node modules
        node: {
            // The default value `true` seems not to work with RxJS
            // TODO: Take a look if this can be enabled
            setImmediate: false,
        },

        // Enable sourcemaps for debugging webpack's output.
        devtool: devServer ? 'cheap-eval-source-map' : 'source-map',

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
    const {serverFile, sourceDir, buildDir, projectRootPath, devServer} = config;
    const {region, apiRoot, assetsRoot, siteRoot} = config;
    // Resolve modules, source, build and static paths
    const sourceDirPath = path.resolve(projectRootPath, sourceDir);
    const buildDirPath = path.resolve(projectRootPath, buildDir);
    const modulesDirPath = path.resolve(projectRootPath, 'node_modules');
    const ownModulesDirPath = path.resolve(__dirname, 'node_modules');

    const gitCommitHash = executeSync('git rev-parse HEAD');
    const gitVersion = executeSync('git describe --always --dirty="-$(git diff-tree HEAD | md5 -q | head -c 8)"');
    const gitBranch = executeSync('git rev-parse --abbrev-ref HEAD');

    // Generate the plugins
    const plugins: webpack.Plugin[] = [
        // Perform type checking for TypeScript
        new ForkTsCheckerWebpackPlugin({
            // Synchronize with the main Webpack compilation, causing it to fail if there are type errors
            async: false,
            // Do not log anything. Any failure will become visible anyway
            silent: true,
            // Use the tsconfig.json in the project folder (not in this library)
            tsconfig: path.resolve(projectRootPath, './tsconfig.json'),
            // Use the tslint.json in the project folder (not in this library)
            tslint: path.resolve(projectRootPath, './tslint.json'),
        }),
        /**
         * Replace "global variables" from the scripts with the constant values.
         */
        new webpack.DefinePlugin({
            // Static assets URL root
            __ASSETS_ROOT__: JSON.stringify(assetsRoot),
            // Web site URL root
            __SITE_ROOT__: JSON.stringify(siteRoot),
            // API URL root
            __API_ROOT__: JSON.stringify(apiRoot),
            // Allow using the GIT commit hash ID
            __COMMIT_HASH__: JSON.stringify(gitCommitHash),
            // Allow using the GIT version
            __VERSION__: JSON.stringify(gitVersion),
            // Allow using the GIT branch name
            __BRANCH__: JSON.stringify(gitBranch),
            // AWS region to which the app is deployed
            __AWS_REGION__: JSON.stringify(region),
        }),
        /**
         * AWS Lambda does not support async iterators Symbol, so
         * we need to provide a polyfill for it.
         */
        new webpack.ProvidePlugin({
            Symbol: [require.resolve('./polyfill/symbol'), 'Symbol'],
        }),
        /**
         * Prevent all the MomentJS locales to be imported by default.
         */
        new webpack.ContextReplacementPlugin(
            /\bmoment[\/\\]locale\b/,
            // Regular expression to match the files that should be imported
            /\ben.js/,
        ),
    ];
    return {
        // Build for running in node environment, instead of web browser
        target: 'node',

        // The main entry points for source files.
        entry: {
            _api: path.resolve(projectRootPath, sourceDir, serverFile as string),
        },

        output: {
            // Output files are placed to this folder
            path: buildDirPath,
            // The file name template for the entry chunks
            filename: '[name].[hash].js',
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
                // Lint JavaScript files using eslint
                {
                    test: /\.jsx?$/,
                    include: sourceDirPath,
                    loader: 'eslint-loader',
                    enforce: 'pre',
                    options: {
                        cache: true,
                        failOnError: true, // Fail the build if there are linting errors
                        failOnWarning: false, // Do not fail the build on linting warnings
                        fix: true, // Auto-fix if possible
                    },
                },
                // Compile TypeScript files ('.ts' or '.tsx')
                {
                    test: /\.tsx?$/,
                    loader: 'ts-loader',
                    options: {
                        // Explicitly expect the tsconfig.json to be located at the project root
                        configFile: path.resolve(projectRootPath, './tsconfig.json'),
                        // Disable type checker - use `fork-ts-checker-webpack-plugin` for that purpose instead
                        transpileOnly: true,
                    },
                },
            ],
        },

        externals: {
            // No need to bundle AWS SDK for compilation, because it will be available in the Lambda node environment
            'aws-sdk': !devServer,
        },

        resolve: {
            // Add '.ts' and '.tsx' as resolvable extensions.
            extensions: ['.ts', '.tsx', '.js'],
        },

        resolveLoader: {
            // Look from this library's node modules!
            modules: [
                ownModulesDirPath,
                modulesDirPath,
            ],
        },

        // Enable sourcemaps for debugging webpack's output.
        devtool: 'source-map',

        // Plugins
        plugins,
    };
}
