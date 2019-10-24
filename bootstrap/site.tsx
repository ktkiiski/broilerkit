/**
 * IMPORTANT: Do not import this file directly!
 * This is used as an endpoint file for a webpack bundle!
 */
import * as React from 'react';
import { hydrate } from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import { AuthOptions, BrowserAuthClient } from '../auth';
import { BrowserClient, CollectionCache, ResourceCache } from '../client';
import { ClientProvider } from '../react/client';

/**
 * Launches the application with the given configuration, to the given element.
 * It assumes that the view has been server-side rendered to the element.
 */
export function start(element: Element, apiRoot: string, authOptions?: AuthOptions | null, resourceCache?: ResourceCache, collectionCache?: CollectionCache) {
    // Webpack bundler loads the configured app site module aliased as '_site'
    const siteModule = require('_site');
    const View: React.ComponentType<{}> = siteModule.default;
    const client = new BrowserClient(apiRoot, authOptions && new BrowserAuthClient(authOptions), resourceCache, collectionCache);
    hydrate(
        <ClientProvider client={client}>
            <BrowserRouter><View /></BrowserRouter>
        </ClientProvider>,
        element,
    );
}
