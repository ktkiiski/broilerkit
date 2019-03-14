import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter, StaticRouterContext } from 'react-router';
import { AuthOptions } from './auth';
import { Client, DummyClient, OperationAction } from './client';
import { encodeSafeJSON, escapeHtml } from './html';
import { HttpRequest, HttpResponse, HttpStatus, Redirect } from './http';
import { errorMiddleware } from './middleware';
import { ClientProvider } from './react/client';
import { MetaContextProvider } from './react/meta';
import { ApiService } from './server';
import { buildQuery, Url } from './url';
import { buildObject, mapObject, pick } from './utils/objects';

export async function renderView(
    request: HttpRequest,
    templateHtml: string,
    view: React.ComponentType<{}>,
    getApiService: () => ApiService,
): Promise<HttpResponse> {
    const {apiRoot, environment} = request;
    const requestQuery = buildQuery(request.queryParameters);
    const location = {
        pathname: request.path,
        search: requestQuery ? `?${requestQuery}` : '',
    };
    const renderRequests: OperationAction[] = [];
    // TODO: Dummy auth client?
    let client = new DummyClient(renderRequests);
    // On the first render, we just find out which resources the view requests
    let renderResult = render(view, client, location);
    // If at least one request was made, perform it and add to cache
    if (renderRequests.length) {
        const apiService = getApiService();
        // Perform the requests and populate the cache
        const cache = await executeRenderRequests(apiService, renderRequests, request);
        // Re-render, now with the cache populated in the Client
        client = new DummyClient(undefined, cache);
        renderResult = render(view, client, location);
    }
    const {viewHtml, meta, routerContext} = renderResult;
    const title = meta.title;
    const styleTags = mapObject(meta.styles, (renderCss, id) => {
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
        encodePrettySafeJSON(apiRoot),
        // Parameters for the AuthClient
        encodePrettySafeJSON(
            environment.AuthClientId && {
                clientId: environment.AuthClientId,
                signInUri: environment.AuthSignInUri,
                signOutUri: environment.AuthSignOutUri,
                signInRedirectUri: environment.AuthSignInRedirectUri,
                signOutRedirectUri: environment.AuthSignOutRedirectUri,
            } as AuthOptions || null,
        ),
        // Populate the state cache for the client
        encodePrettySafeJSON(client.stateCache$.getValue()),
    ];
    const startupScript = `<script>\napp.start(${
        process.env.NODE_ENV === 'production'
            ? launchParams.join(',')
            : `\n${launchParams.join(',\n')}\n`
    });\n</script>`;
    const body = templateHtml
        // Inject the bootstrap script just before enclosing </body>
        .replace(/<\/body>/i, (end) => `${startupScript}\n${end}`)
        // Inject the view HTML to the div with the ID "app"
        .replace(/(\<div\s+id="app"\>)[\s\S]*?(<\/div>)/i, (_, start, end) => `${start}${viewHtml}${end}`)
        // Replace the title
        .replace(/(<title>)([\s\S]*?)(<\/title>)/i, (match, start, _, end) => (
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

function render(View: React.ComponentType<{}>, client: Client, location: object) {
    const routerContext: StaticRouterContext = {};
    const meta = {
        title: undefined as string | undefined,
        styles: {} as Record<string, () => string | null>,
        idCounter: 0,
    };
    const viewHtml = renderToString((
        <MetaContextProvider context={meta}>
            <ClientProvider client={client}>
                <StaticRouter location={location} context={routerContext}>
                    <View />
                </StaticRouter>
            </ClientProvider>
        </MetaContextProvider>
    ));
    if (routerContext.url) {
        // Redirect
        let {statusCode} = routerContext;
        if (statusCode !== HttpStatus.Found && statusCode !== HttpStatus.MovedPermanently) {
            statusCode = HttpStatus.Found;
        }
        throw new Redirect(routerContext.url, statusCode);
    }
    return {viewHtml, routerContext, meta};
}

async function executeRenderRequests(apiService: ApiService, actions: OperationAction[], request: HttpRequest) {
    const distinctRenderRequests = buildObject(actions, (action) => {
        const url = action.operation.route.compile(action.input);
        return [url.toString(), url];
    });
    const results = await Promise.all(
        mapObject(distinctRenderRequests, async (url, urlStr) => {
            const result = await executeRenderRequest(apiService, url, request);
            return {[urlStr]: result};
        }),
    );
    return Object.assign({}, ...results);
}

async function executeRenderRequest(apiService: ApiService, url: Url, origRequest: HttpRequest) {
    const execute = errorMiddleware(apiService.execute);
    try {
        const response = await execute({
            // Copy most of the properties from the original request
            ...pick(origRequest, [
                'apiOrigin', 'apiRoot', 'environment',
                'auth', 'region', 'siteOrigin', 'siteRoot',
            ]),
            // Set up properties for the render request
            method: 'GET',
            path: url.path,
            queryParameters: url.queryParams,
            body: undefined,
            headers: {
                Accept: 'application/json',
            },
        });
        // Only API responses are supported on the server-side
        if (response.statusCode === HttpStatus.OK && 'data' in response) {
            return response.data;
        }
        // tslint:disable-next-line:no-console
        console.warn(`Server-side rendering GET request to ${url} failed with status code ${response.statusCode}`);
    } catch (error) {
        // tslint:disable-next-line:no-console
        console.error(`Server-side rendering GET request to ${url} failed: ${error}`);
    }
    return null;
}

function encodePrettySafeJSON(value: any) {
    return encodeSafeJSON(
        value, null, process.env.NODE_ENV === 'production' ? undefined : 2,
    );
}
