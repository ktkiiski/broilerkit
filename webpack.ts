import * as _ from 'lodash';
import * as path from 'path';
import * as webpack from 'webpack';

import { IAppConfig } from './config';
import { executeSync } from './exec';

// Webpack plugins
const ExtractTextPlugin = require('extract-text-webpack-plugin');
const FaviconsWebpackPlugin = require('favicons-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

export interface IWebpackConfigOptions extends IAppConfig {
    devServer: boolean;
}

/**
 * Creates the Webpack 2 configuration for the front-end asset compilation.
 * The options are documented at
 * https://webpack.js.org/configuration/
 */
export function getFrontendWebpackConfig(config: IWebpackConfigOptions): webpack.Configuration {
    const {devServer, debug, iconFile, sourceDir, buildDir, pages, projectRoot} = config;
    const {apiOrigin, assetsOrigin, siteOrigin} = config;
    // Resolve modules, source, build and static paths
    const projectDirPath = path.resolve(process.cwd(), projectRoot);
    const sourceDirPath = path.resolve(projectDirPath, sourceDir);
    const scriptPaths = _.union(..._.map(pages, (page) => page.scripts));
    const buildDirPath = path.resolve(projectDirPath, buildDir);
    const modulesDirPath = path.resolve(projectDirPath, 'node_modules');
    const ownModulesDirPath = path.resolve(__dirname, 'node_modules');

    const gitCommitHash = executeSync('git rev-parse HEAD');
    const gitVersion = executeSync('git describe --always --dirty="-$(git diff-tree HEAD | md5 -q | head -c 8)"');
    const gitBranch = executeSync('git rev-parse --abbrev-ref HEAD');
    // Generate the plugins
    const plugins: webpack.Plugin[] = [
        // Extract stylesheets to separate files in production
        new ExtractTextPlugin({
            disable: devServer,
            filename: debug ? '[name].css' : '[name].[hash].css',
        }),
        // Create HTML plugins for each webpage
        ...pages.map(
            ({file, title, scripts}) => new HtmlWebpackPlugin({
                title,
                filename: path.format({..._.pick(path.parse(file), 'dir', 'name'), ext: '.html'}),
                template: path.resolve(sourceDirPath, file),
                chunks: scripts.map((name) => path.basename(name).replace(/\..*?$/, '')),
                // Insert tags for stylesheets and scripts
                inject: true,
                // No cache-busting needed, because hash is included in file names
                hash: false,
            }),
        ),
        /**
         * Replace "global variables" from the scripts with the constant values.
         */
        new webpack.DefinePlugin({
            // This will strip out development features from React when building for production
            'process.env': {
                NODE_ENV: JSON.stringify(debug ? 'development' : 'production'),
            },
            // Static assets URL origin
            '__ASSETS_ORIGIN__': JSON.stringify(assetsOrigin),
            // Web site URL origin
            '__SITE_ORIGIN__': JSON.stringify(siteOrigin),
            // API URL origin
            '__API_ORIGIN__': JSON.stringify(apiOrigin),
            // Allow using the GIT commit hash ID
            '__COMMIT_HASH__': JSON.stringify(gitCommitHash),
            // Allow using the GIT version
            '__VERSION__': JSON.stringify(gitVersion),
            // Allow using the GIT branch name
            '__BRANCH__': JSON.stringify(gitBranch),
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
    /**
     * If icon source file is provided, generate icons for the app.
     * For configuration, see https://github.com/jantimon/favicons-webpack-plugin
     */
    if (iconFile) {
        plugins.push(
            new FaviconsWebpackPlugin({
                // Your source logo
                logo: iconFile,
                // The prefix for all image files (might be a folder or a name)
                prefix: debug ? 'icons/' : 'icons/[hash]/',
                // Emit all stats of the generated icons
                emitStats: true,
                // Generate a cache file with control hashes and
                // don't rebuild the favicons until those hashes change
                persistentCache: true,
                // Inject the html into the html-webpack-plugin
                inject: true,
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
        entry: _.fromPairs(
            scriptPaths.map((entry) => [
                path.basename(entry).replace(/\..*?$/, ''),
                [path.resolve(sourceDirPath, entry)],
            ]),
        ),

        output: {
            // Output files are placed to this folder
            path: buildDirPath,
            // The file name template for the entry chunks
            filename: debug ? '[name].js' : '[name].[chunkhash].js',
            // The URL to the output directory resolved relative to the HTML page
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
                // Lint TypeScript files using tslint
                {
                    test: /\.tsx?$/,
                    include: sourceDirPath,
                    loader: 'tslint-loader',
                    enforce: 'pre',
                    options: {
                        fix: true, // Auto-fix if possible
                    },
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
                    loader: 'awesome-typescript-loader',
                    options: {
                        // Explicitly expect the tsconfig.json to be located at the project root
                        configFileName: path.resolve(projectDirPath, './tsconfig.json'),
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
            // Look import modules from these directories
            modules: [
                sourceDirPath,
                modulesDirPath,
            ],
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
export function getBackendWebpackConfig(config: IWebpackConfigOptions): webpack.Configuration {
    const {apiPath, sourceDir, buildDir, projectRoot} = config;
    const {apiOrigin, assetsOrigin, siteOrigin} = config;
    // Resolve modules, source, build and static paths
    const projectDirPath = path.resolve(process.cwd(), projectRoot);
    const sourceDirPath = path.resolve(projectDirPath, sourceDir);
    const buildDirPath = path.resolve(projectDirPath, buildDir);
    const modulesDirPath = path.resolve(projectDirPath, 'node_modules');
    const ownModulesDirPath = path.resolve(__dirname, 'node_modules');

    const gitCommitHash = executeSync('git rev-parse HEAD');
    const gitVersion = executeSync('git describe --always --dirty="-$(git diff-tree HEAD | md5 -q | head -c 8)"');
    const gitBranch = executeSync('git rev-parse --abbrev-ref HEAD');

    // Generate the plugins
    const plugins: webpack.Plugin[] = [
        /**
         * Replace "global variables" from the scripts with the constant values.
         */
        new webpack.DefinePlugin({
            // Static assets URL origin
            __ASSETS_ORIGIN__: JSON.stringify(assetsOrigin),
            // Web site URL origin
            __SITE_ORIGIN__: JSON.stringify(siteOrigin),
            // API URL origin
            __API_ORIGIN__: JSON.stringify(apiOrigin),
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
            _api: path.resolve(projectDirPath, apiPath),
        },

        output: {
            // Output files are placed to this folder
            path: buildDirPath,
            // The file name template for the entry chunks
            filename: '[name].[hash].js',
            // The URL to the output directory resolved relative to the HTML page
            publicPath: `${assetsOrigin}/`,
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
                // Lint TypeScript files using tslint
                {
                    test: /\.tsx?$/,
                    include: sourceDirPath,
                    loader: 'tslint-loader',
                    enforce: 'pre',
                    options: {
                        fix: true, // Auto-fix if possible
                    },
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
                    loader: 'awesome-typescript-loader',
                    options: {
                        // Explicitly expect the tsconfig.json to be located at the project root
                        configFileName: path.resolve(projectDirPath, './tsconfig.json'),
                    },
                },
            ],
        },

        externals: {
            // No need to bundle AWS SDK, because it will be available in the Lambda node environment
            'aws-sdk': true,
        },

        resolve: {
            // Look import modules from these directories
            modules: [
                sourceDirPath,
                modulesDirPath,
            ],
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
