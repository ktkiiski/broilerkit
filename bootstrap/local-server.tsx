/**
 * IMPORTANT: Do not import this file directly!
 * This is used as an endpoint file for a webpack bundle!
 */
import * as React from 'react';
import authLocalServer from '../auth-local-server';
import { OAUTH2_SIGNIN_ENDPOINT_NAME, OAuth2SignInController } from '../oauth';
import { OAUTH2_SIGNOUT_ENDPOINT_NAME, OAuth2SignOutController } from '../oauth';
import { OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME, OAuth2SignedInController } from '../oauth';
import { OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME, OAuth2SignedOutController } from '../oauth';
import { Database } from '../postgres';
import LocalAuthRouter from '../react/components/LocalAuthRouter';
import { ApiService } from '../server';
import { RENDER_WEBSITE_ENDPOINT_NAME, SsrController } from '../ssr';
import { LOCAL_UPLOAD_ENDPOINT_NAME, LocalUploadController } from '../storage';

export const getApiService = (pageHtml$: Promise<string>, uploadDirPath: string) => {
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
        [OAUTH2_SIGNIN_ENDPOINT_NAME]: new OAuth2SignInController(),
        [OAUTH2_SIGNOUT_ENDPOINT_NAME]: new OAuth2SignOutController(),
        [OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedInController(),
        [OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedOutController(),
        [LOCAL_UPLOAD_ENDPOINT_NAME]: new LocalUploadController(uploadDirPath),
    });
};

export const getDatabase = (): Database | null => {
    try {
        return require('_db').default;
    } catch {
        return null;
    }
};
