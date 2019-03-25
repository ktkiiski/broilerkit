import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter, StaticRouterContext } from 'react-router';
import { AuthOptions } from './auth';
import { Client, CollectionCache, CollectionState, DummyClient, Listing, ResourceCache, ResourceState, Retrieval } from './client';
import { encodeSafeJSON, escapeHtml } from './html';
import { ApiResponse, HttpRequest, HttpResponse, HttpStatus, Redirect } from './http';
import { toJavaScript } from './javascript';
import { errorMiddleware } from './middleware';
import { ClientProvider } from './react/client';
import { MetaContextProvider } from './react/meta';
import { Serializer } from './serializers';
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
    const retrievals: Retrieval[] = [];
    const listings: Listing[] = [];
    // TODO: Dummy auth client?
    let client = new DummyClient(retrievals, listings, {}, {});
    // On the first render, we just find out which resources the view requests
    let renderResult = render(view, client, location);
    // If at least one request was made, perform it and add to cache
    if (retrievals.length || listings.length) {
        const apiService = getApiService();
        // Perform the requests and populate the cache
        const [resourceCache, collectionCache] = await Promise.all([
            executeRetrievals(apiService, retrievals, request),
            executeListings(apiService, listings, request),
        ]);
        // Re-render, now with the cache populated in the Client
        client = new DummyClient(null, null, resourceCache, collectionCache);
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
        encodePrettyJavaScript(client.resourceCache),
        encodePrettyJavaScript(client.collectionCache),
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

async function executeRetrievals(apiService: ApiService, retrievals: Retrieval[], request: HttpRequest): Promise<ResourceCache> {
    const distinctRetrievals = getActionUrls(retrievals);
    const cache: ResourceCache = {};
    await Promise.all(
        mapObject(distinctRetrievals, async ([url, retrieval], urlStr) => {
            const {operation} = retrieval;
            const resourceName = operation.endpoint.resource.name;
            const [resource, error] = await executeRenderRequest(apiService, url, request, operation.responseSerializer);
            const state: ResourceState = { resource, error, isLoading: false };
            cache[resourceName] = Object.assign(cache[resourceName] || {}, {[urlStr]: state});
        }),
    );
    return cache;
}

async function executeListings(apiService: ApiService, listings: Listing[], request: HttpRequest): Promise<CollectionCache> {
    const distinctListings = getActionUrls(listings);
    const cache: CollectionCache = {};
    await Promise.all(
        mapObject(distinctListings, async ([url, listing], urlStr) => {
            const {operation} = listing;
            const resourceName = operation.endpoint.resource.name;
            const [page, error] = await executeRenderRequest(apiService, url, request, operation.responseSerializer);
            const state: CollectionState = {
                resources: page ? page.results : [],
                count: page ? page.results.length : 0,
                isLoading: false,
                isComplete: !!page && !page.next,
                error,
                ordering: listing.input.ordering,
                direction: listing.input.direction,
            };
            cache[resourceName] = Object.assign(cache[resourceName] || {}, {[urlStr]: state});
        }),
    );
    return cache;
}

function getActionUrls<T extends Retrieval | Listing>(actions: T[]): Record<string, [Url, T]> {
    return buildObject(actions, (action) => {
        try {
            const url = action.operation.route.compile(action.input as any);
            return [url.toString(), [url, action] as [Url, T]];
        } catch {
            // Omit on error (e.g. invalid input)
        }
    });
}

async function executeRenderRequest<T>(apiService: ApiService, url: Url, origRequest: HttpRequest, serializer: Serializer<T>): Promise<[T | null, ApiResponse | null]> {
    const execute = errorMiddleware(apiService.execute);
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
    if ('data' in response) {
        if (response.statusCode === HttpStatus.OK && 'data' in response && response.data) {
            return [serializer.deserialize(response.data), null];
        }
        if (response.statusCode >= 400) {
            return [null, response];
        }
    }
    return [null, null];
}

function encodePrettySafeJSON(value: unknown) {
    return encodeSafeJSON(
        value, null, process.env.NODE_ENV === 'production' ? undefined : 2,
    );
}

function encodePrettyJavaScript(value: unknown) {
    return toJavaScript(
        value, process.env.NODE_ENV === 'production' ? undefined : 2,
    );
}
