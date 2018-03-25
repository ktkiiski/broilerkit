/**
 * The root URL of the static assets, not containing
 * the trailing slash. Example: "https://static.example.com"
 */
declare const __ASSETS_ROOT__: string;

/**
 * The root URL of the web site, not containing
 * the trailing slash. Example: "https://www.example.com"
 */
declare const __SITE_ROOT__: string;

/**
 * The root URL of the REST API, not containing
 * the trailing slash. Example: "https://api.example.com"
 */
declare const __API_ROOT__: string;

/**
 * GIT commit hash of the web app build.
 */
declare const __COMMIT_HASH__: string;

/**
 * The version of the app as described by
 * the GIT command `git describe`.
 */
declare const __VERSION__: string;

/**
 * The GIT branch that was used to build the app.
 */
declare const __BRANCH__: string;

/**
 * The AWS region to which the app is deployed,
 * and in which it is running.
 */
declare const __AWS_REGION__: string;

/**
 * The AWS stack name to which the app is deployed.
 */
declare const __AWS_STACK_NAME__: string;
