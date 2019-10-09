/**
 * IMPORTANT: Do not import this file directly!
 * This is used as an endpoint file for a webpack bundle!
 */
import { readFile } from '../fs';
import { LambdaHttpHandler, lambdaMiddleware } from '../lambda';
import { middleware } from '../middleware';
import { OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME, OAuth2SignInController } from '../oauth';
import { OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME, OAuth2SignOutController } from '../oauth';
import { ApiService } from '../server';
import { RENDER_WEBSITE_ENDPOINT_NAME, SsrController } from '../ssr';

// When deployed, load the HTML base file immediately, which is expected to be located as a sibling index.html file
const pageHtml$ = readFile('./index.html');
// API service
const apiService = getApiService();
// Load the module exporting the rendered React component
const view: React.ComponentType<{}> = require('_site').default;
const service = apiService.extend({
    [RENDER_WEBSITE_ENDPOINT_NAME]: new SsrController(apiService, view, pageHtml$),
    [OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME]: new OAuth2SignInController(),
    [OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME]: new OAuth2SignOutController(),
});

const cache = {};
const executeLambda = lambdaMiddleware(middleware(
    async (req) => service.execute(req, cache),
));

/**
 * AWS Lambda compatible handler function that processes the given
 * requests by performing the server-side rendering of the view, and
 * calling the callback with a HTML page response.
 *
 * The view is imported with `require('_site')`, which will be aliased
 * with the bundler. Therefore, this function can only be called from
 * the actual bundled script.
 */
export const request: LambdaHttpHandler = (lambdaRequest, _, callback) => {
    executeLambda(lambdaRequest).then(
        (result) => callback(null, result),
        (error) => callback(error),
    );
};

function getApiService() {
    let apiModule;
    try {
        apiModule = require('_service');
    } catch {
        // No API available
        return new ApiService({});
    }
    return new ApiService(apiModule.default);
}
