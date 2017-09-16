/**
 * The origin of the static asset URLs, not containing
 * the trailing slash. Example: "https://static.example.com"
 */
declare const __ASSETS_ORIGIN__: string;

/**
 * The origin of the web site URLs, not containing
 * the trailing slash. Example: "https://www.example.com"
 */
declare const __SITE_ORIGIN__: string;

/**
 * The origin of the REST API URLs, not containing
 * the trailing slash. Example: "https://api.example.com"
 */
declare const __API_ORIGIN__: string;

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
