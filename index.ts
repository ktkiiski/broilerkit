import type { RegionCode } from './regions';

export type DeploymentRegionCode = RegionCode | 'local';

export interface StageConfig {
    /**
     * To which Amazon region the web app will be hosted.
     * Use region `local` when developing locally.
     */
    region: DeploymentRegionCode;
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
     * The base URL where the server is hosted. This must contain the protocol,
     * hostname and optionally any port. The root URL must NOT end with a trailing slash.
     *
     * Examples:
     * - "https://www.example.com"
     * - "http://localhost:8080"
     */
    serverRoot: string;
    /**
     * If the app uses a database, it needs to belong to a VPC.
     * Define the identifier for the VPC. It will be reated if it does not exists.
     * You may use an existing VPC shared with another app. The VPC stack
     * will always be updated on deployment.
     */
    vpc?: string;
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

export interface ParameterConfig {
    /**
     * Human-readable description of the configuration.
     */
    description: string;
}

export interface AppConfig {
    /**
     * The name of the web app. Should include only letters, numbers, and dashes.
     */
    name: string;
    /**
     * Human-readable title for the app.
     */
    title: string;
    /**
     * Icon file for your app that is used to generate favicons and mobile-compatible
     * icons. The path is relative to the source directory.
     */
    iconFile: string;
    /**
     * The file containing the React component that renders the website.
     * You should use React Router for different URLs.
     * The component should be the default export of this file.
     */
    siteFile: string;
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
    /**
     * Relative path to the module that exports all the database tables.
     * The path must be relative to the source directory.
     * Should be defined if your app is using a database.
     */
    databaseFile?: string;
    /**
     * Relative path to the module that exports all the storage buckets.
     * The path must be relative to the source directory.
     * Should be defined if your app is using file storage buckets,
     * for example for allowing users to upload files.
     */
    bucketsFile?: string;
    /**
     * Relative path to the module that exports all the backend event trigger handlers.
     * The path must be relative to the source directory.
     */
    triggersFile?: string;
    /**
     * Additional parameters the backend requires to work.
     * These will be asked when deploying each environment.
     */
    parameters?: {
        /**
         * Parameter name as a key and it's configuration as a value.
         */
        [param: string]: ParameterConfig;
    };
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
        const { stage } = options;
        const { config } = this;
        return { ...config, ...config.stages[stage], ...options };
    }
}

/**
 * Configures a web app.
 * @param config Configuration for the web app
 */
export function app(config: AppConfig): App {
    return new App(config);
}
