export interface StageConfig {
    /**
     * The base URL where all the indefinitely-cached static assets are hosted.
     * This must contain the protocol, hostname and optionally any port. The root URL
     * must NOT end with a trailing slash.
     *
     * Examples:
     * - "https://static.example.com"
     * - "http://localhost:8080"
     */
    assetsRoot: string;
    /**
     * The base URL where the HTML pages are hosted. This must contain the protocol,
     * hostname and optionally any port. The root URL must NOT end with a trailing slash.
     *
     * Examples:
     * - "https://www.example.com"
     * - "http://localhost:8080"
     */
    siteRoot: string;
    /**
     * The base URL where the REST API is hosted. This must contain the protocol,
     * hostname and optionally any port. The root URL must NOT end with a trailing slash.
     *
     * You may omit this if the app does not have an API.
     *
     * Examples:
     * - "https://api.example.com"
     * - "http://localhost:8081"
     */
    apiRoot?: string;
}

export interface WebPageConfig {
    /**
     * Title of this web page.
     */
    title: string;
    /**
     * The HTML file path relative to the source directory.
     */
    file: string;
    /**
     * List of scripts entries to inject to the web page,
     * relative to the source directory.
     */
    scripts: string[];
}

export interface AuthConfig {
    /**
     * The Facebook client ID for sign in.
     * Enabling this will enable Facebook login possibility.
     */
    facebookClientId?: string;
    /**
     * The Google client ID for sign in.
     * Enabling this will enable Facebook login possibility.
     */
    googleClientId?: string;
}

export interface AppConfig {
    /**
     * The name of the web app. Should include only letters, numbers, and dashes.
     */
    name: string;
    /**
     * Icon file for your app that is used to generate favicons and mobile-compatible
     * icons. The path is relative to the source directory.
     */
    iconFile: string;
    /**
     * Pages
     */
    pages: WebPageConfig[];
    /**
     * Optional default web page that will be served when no web page file
     * is found by the requested URL. If null or undefined, an 404 error page will be
     * shown. Otherwise, the defined file will be served with 200 response.
     *
     * This is useful for single page apps using HTML5 History API.
     */
    defaultPage?: string;
    /**
     * To which Amazon region the web app will be hosted.
     * Currently, only 'us-east-1' is supported!
     */
    region: 'us-east-1';
    /**
     * Configuration for each different stage that is used by this app.
     */
    stages: {
        /**
         * Stage name as a key and the stage's configuration as a value.
         */
        [stage: string]: StageConfig;
    };
    /**
     * Relative path to the module that defines the server implementation.
     * The path must be relative to the source directory.
     */
    serverFile?: string;
    /**
     * The folder containing all the source files for your app.
     * Other paths in this configuration are relative to this.
     */
    sourceDir: string;
    /**
     * Configuration for the user registry.
     */
    auth?: AuthConfig;
}

export interface ConfigOptions {
    /**
     * Name of the current app stage.
     */
    stage: string;
    /**
     * Whether or not the app stage is in debugging mode.
     * If true, the app compilation will be unminimized, unoptimized and source maps
     * are fully enabled in order to make debugging much easier.
     * If false (recommended for the production build) the bundle will
     * be compressed and optimized.
     */
    debug: boolean;
    /**
     * The full absolute path to the root folder where the app project
     * is located. Other directory and file names are always relative
     * to this path.
     */
    projectRootPath: string;
}

export interface AppStageConfig extends AppConfig, StageConfig, ConfigOptions {}

export class App {
    constructor(public readonly config: AppConfig) {}

    public configure(options: ConfigOptions): AppStageConfig {
        const {stage} = options;
        const {config} = this;
        return {...config, ...config.stages[stage], ...options};
    }
}

/**
 * Configures a web app.
 * @param config Configuration for the web app
 */
export function app(config: AppConfig) {
    return new App(config);
}
