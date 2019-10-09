/**
 * IMPORTANT: Do not import this file directly!
 * This is used as an endpoint file for a webpack bundle!
 */
import * as React from 'react';
import authLocalServer from '../auth-local-server';
import { OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME, OAuth2SignInController } from '../oauth';
import { OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME, OAuth2SignOutController } from '../oauth';
import LocalAuthRouter from '../react/components/LocalAuthRouter';
import { ApiService } from '../server';
import { RENDER_WEBSITE_ENDPOINT_NAME, SsrController } from '../ssr';

export default (pageHtml$: Promise<string>) => {
    let module;
    try {
        module = require('_service');
    } catch {
        // No API available
        return new ApiService({});
    }
    const apiService = new ApiService(module.default).extend(authLocalServer);
    // Load the module exporting the rendered React component
    const siteModule = require('_site');
    const view: React.ComponentType<{}> = siteModule.default;
    return apiService.extend({
        [RENDER_WEBSITE_ENDPOINT_NAME]: new SsrController(
            apiService,
            () => (<LocalAuthRouter component={view} />),
            pageHtml$,
        ),
        [OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME]: new OAuth2SignInController(),
        [OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME]: new OAuth2SignOutController(),
    });
};
