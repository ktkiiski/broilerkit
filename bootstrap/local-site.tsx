import * as React from 'react';
import { hydrate } from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import { AuthClient, AuthOptions } from '../auth';
import { Client } from '../client';
import { ClientProvider } from '../react/client';
import LocalAuthRouter from '../react/components/LocalAuthRouter';

/**
 * Launches the application with the given configuration, to the given element.
 * It assumes that the view has been server-side rendered to the element.
 */
export function start(element: Element, apiRoot: string, authOptions?: AuthOptions, stateCache?: Record<string, any>) {
    // Webpack bundler loads the configured app site module aliased as '_site'
    const siteModule = require('_site');
    const View: React.ComponentType<{}> = siteModule.default;
    const client = new Client(apiRoot, authOptions && new AuthClient(authOptions), undefined, stateCache);
    hydrate(
        <ClientProvider client={client}>
            <BrowserRouter>
                <LocalAuthRouter component={View} />
            </BrowserRouter>
        </ClientProvider>,
        element,
    );
}