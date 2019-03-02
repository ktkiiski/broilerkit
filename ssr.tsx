import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter, StaticRouterContext } from 'react-router';
import { AuthOptions } from './auth';
import { encodeSafeJSON, escapeHtml } from './html';
import { HttpRequest, HttpResponse } from './http';
import { MetaContextProvider } from './react/meta';
import { buildQuery } from './url';
import { mapObject } from './utils/objects';

export async function renderView(request: HttpRequest, pageHtml: string, View: React.ComponentType<{}>): Promise<HttpResponse> {
    const {apiRoot, environment} = request;
    const requestQuery = buildQuery(request.queryParameters);
    const location = {
        pathname: request.path,
        search: requestQuery ? `?${requestQuery}` : '',
    };
    const routerContext: StaticRouterContext = {};
    const metaContext = {
        title: undefined as string | undefined,
        styles: {} as Record<string, () => string | null>,
        idCounter: 0,
    };
    // TODO: Dummy client with ClientProvider?
    const viewHtml = renderToString((
        <MetaContextProvider context={metaContext}>
            <StaticRouter location={location} context={routerContext}>
                <View />
            </StaticRouter>
        </MetaContextProvider>
    ));
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
    const title = metaContext.title;
    const styleTags = mapObject(metaContext.styles, (renderCss, id) => {
        const css = renderCss();
        if (!css) {
            return '';
        }
        // TODO: Need to be escaped somehow?
        return `\n<style type="text/css" id="${escapeHtml(id)}">${css}</style>`;
    });
    const metaHtml = styleTags.join('');

    const launchParams = [
        'document.getElementById("app")',
        encodeSafeJSON(apiRoot),
    ];
    if (environment.AuthClientId) {
        const authOptions: AuthOptions = {
            clientId: environment.AuthClientId,
            signInUri: environment.AuthSignInUri,
            signOutUri: environment.AuthSignOutUri,
            signInRedirectUri: environment.AuthSignInRedirectUri,
            signOutRedirectUri: environment.AuthSignOutRedirectUri,
        };
        launchParams.push(encodeSafeJSON(authOptions));
    }
    const startupScript = `<script>app.start(${launchParams.join(',')});</script>`;
    const body = pageHtml
        // Inject the bootstrap script just before enclosing </body>
        .replace(/<\/body>/i, (end) => `${startupScript}\n${end}`)
        // Inject the view HTML to the div with the ID "app"
        .replace(/(\<div\s+id="app"\>).*?(<\/div>)/mi, (_, start, end) => `${start}${viewHtml}${end}`)
        // Replace the title
        .replace(/(<title>)(.*?)(<\/title>)/mi, (match, start, _, end) => (
            title ? `${start}${escapeHtml(title)}${end}` : match
        ))
        // Inject any meta tags just before enclosing </head>
        .replace(/<\/head>/i, (end) => `${metaHtml}\n${end}`)
    ;
    // Return the HTML response
    return {
        statusCode: routerContext.statusCode || 200,
        headers: {
            'Content-Type': 'text/html; charset=UTF-8',
        },
        body,
    };
}
