import { readFile } from '../fs';
import { LambdaHttpHandler, lambdaMiddleware } from '../lambda';
import { middleware } from '../middleware';
import { renderView } from '../ssr';

// When deployed, load the HTML base file immediately, which is expected to be located as a sibling index.html file
const pageHtml$ = readFile('./index.html');

const executeLambda = lambdaMiddleware(middleware(async (req) => {
    const pageHtml = await pageHtml$;
    // Load the module exporting the rendered React component
    const siteModule = require('_site');
    const view: React.ComponentType<{}> = siteModule.default;
    return await renderView(
        req,
        pageHtml,
        view,
        () => require('_service').default,
    );
}));

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
