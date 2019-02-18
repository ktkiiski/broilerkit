import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { AuthClient } from '../auth';
import { Client } from '../client';
import { ClientProvider } from '../react/client';

/**
 * The root URL of the REST API, not containing
 * the trailing slash. Example: "https://api.example.com"
 */
declare const __API_ROOT__: string;

/**
 * Options that should be passed to the authentication client:
 *
 *     const client = new AuthClient(__AUTH_OPTIONS__);
 */
declare const __AUTH_OPTIONS__: {
    clientId: string;
    signInUri: string;
    signOutUri: string;
    signInRedirectUri: string;
    signOutRedirectUri: string;
};

function start() {
    // Webpack bundler loads the configured app site module aliased as '_site'
    const siteModule = require('_site');
    const View: React.ComponentType<{}> = siteModule.default;
    const authClient = new AuthClient(__AUTH_OPTIONS__);
    const client = new Client(__API_ROOT__, authClient);
    ReactDOM.render(
        <ClientProvider client={client}>
            <View />,
        </ClientProvider>,
        document.getElementById('app'),
    );
}

// TODO: Call this from the HTML page
start();
