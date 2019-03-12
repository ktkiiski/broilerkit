import * as React from 'react';
import { hydrate } from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import { AuthClient, AuthOptions } from '../auth';
import { Client } from '../client';
import { ClientProvider } from '../react/client';

/**
 * Launches the application with the given configuration, to the given element.
 * It assumes that the view has been server-side rendered to the element.
 */
export function start(element: Element, apiRoot: string, authOptions?: AuthOptions | null, stateCache?: Record<string, any>) {
    // Webpack bundler loads the configured app site module aliased as '_site'
    const siteModule = require('_site');
    const View: React.ComponentType<{}> = siteModule.default;
    const client = new Client(apiRoot, authOptions && new AuthClient(authOptions), undefined, stateCache);
    hydrate(
        <ClientProvider client={client}>
            <BrowserRouter><View /></BrowserRouter>
        </ClientProvider>,
        element,
    );
}
