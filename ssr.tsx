import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter, StaticRouterContext } from 'react-router';
import { AuthOptions } from './auth';
import { encodeSafeJSON, escapeHtml } from './html';
import { HttpRequest, HttpResponse } from './http';
import { buildQuery } from './url';

export async function renderView(request: HttpRequest, pageHtml: string, View: React.ComponentType<{}>): Promise<HttpResponse> {
    const {apiRoot, environment} = request;
    const requestQuery = buildQuery(request.queryParameters);
    const location = {
        pathname: request.path,
        search: requestQuery ? `?${requestQuery}` : '',
    };
    const routerContext: StaticRouterContext = {};
    // TODO: Dummy client with ClientProvider?
    const viewHtml = renderToString(
        <StaticRouter location={location} context={routerContext}>
            <View />
        </StaticRouter>,
    );
    if (routerContext.url) {
        // Redirect
        const statusCode = routerContext.statusCode || 302;
        if (statusCode !== 301 && statusCode !== 302) {
            throw new Error(`Invalid redirection status code ${statusCode}`);
        }
        return {
            statusCode: routerContext.statusCode || 302,
            headers: {
                Location: routerContext.url,
            },
            body: '',
        };
    }
    const title = ''; // TODO
    const authOptions = environment.AuthClientId && {
        clientId: environment.AuthClientId,
        signInUri: environment.AuthSignInUri,
        signOutUri: environment.AuthSignOutUri,
        signInRedirectUri: environment.AuthSignInRedirectUri,
        signOutRedirectUri: environment.AuthSignOutRedirectUri,
    } || undefined;
    // Return the HTML response
    return {
        statusCode: routerContext.statusCode || 200,
        headers: {
            'Content-Type': 'text/html; charset=UTF-8',
        },
        body: buildWebPage(pageHtml, viewHtml, title, apiRoot, authOptions),
    };
}

function buildWebPage(pageHtml: string, viewHtml: string, title: string, apiRoot: string, auth?: AuthOptions): string {
    const launchParams = [
        'document.getElementById("app")',
        encodeSafeJSON(apiRoot),
    ];
    if (auth) {
        launchParams.push(encodeSafeJSON(auth));
    }
    const startupScript = `<script>app.start(${launchParams.join(',')});</script>`;
    return pageHtml
        // Inject the bootstrap script just before enclosing </body>
        .replace(/<\/body>/i, () => `${startupScript}\n</body>`)
        // Inject the view HTML to the div with the ID "app"
        .replace(/(\<div\s+id="app"\>).*?(<\/div>)/mi, (_, start, end) => `${start}${viewHtml}${end}`)
        // Remove any existing <title> tag
        .replace(/<title>\.*?<\/title>/mi, '')
        // Inject <title> tag just before enclosing </head>
        .replace(/<\/head>/mi, () => `<title>${escapeHtml(title)}</title>\n</head>`)
    ;
}
