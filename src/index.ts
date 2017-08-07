export interface IStageConfig {
    /**
     * Domain where all the indefinitely-cached static assets are hosted.
     */
    assetsDomain: string;
    /**
     * Domain where the HTML pages are hosted.
     */
    siteDomain: string;
}

export interface IWebPageConfig {
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

export interface IAppConfig {
    /**
     * The name of the web app. Should include only letters, numbers, and dashes.
     */
    appName: string;
    /**
     * Which version of BroilerKit is this app using?
     */
    broilerKitVersion: string;
    /**
     * Icon file for your app that is used to generate favicons and mobile-compatible
     * icons. The path is relative to the source directory.
     */
    iconFile: string;
    /**
     * Pages
     */
    pages: IWebPageConfig[];
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
        [stage: string]: IStageConfig;
    };
    /**
     * The folder containing all the source files for your app.
     */
    sourceDir: string;
}
