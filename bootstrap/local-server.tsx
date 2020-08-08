/**
 * IMPORTANT: Do not import this file directly!
 * This is used as an endpoint file for a webpack bundle!
 */
// @ts-ignore: Webpack bundler loads the configured app site module aliased as '_site'
import View from '_site';
import * as React from 'react';
import authLocalServer from '../auth-local-server';
import {
    OAUTH2_SIGNIN_ENDPOINT_NAME,
    OAuth2SignInController,
    OAUTH2_SIGNOUT_ENDPOINT_NAME,
    OAuth2SignOutController,
    OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME,
    OAuth2SignedInController,
    OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME,
    OAuth2SignedOutController,
} from '../oauth';
import type { Database } from '../postgres';
import LocalAuthRouter from '../react/components/LocalAuthRouter';
import { ApiService } from '../server';
import { RENDER_WEBSITE_ENDPOINT_NAME, SsrController } from '../ssr';
import { LOCAL_UPLOAD_ENDPOINT_NAME, LocalUploadController } from '../storage';

export function getApiService(pageHtml$: Promise<string>, uploadDirPath: string): ApiService {
    let module;
    try {
        module = require('_service');
    } catch {
        // No API available
        return new ApiService({});
    }
    const apiService = new ApiService(module.default).extend(authLocalServer);
    return apiService.extend({
        [RENDER_WEBSITE_ENDPOINT_NAME]: new SsrController(
            apiService,
            () => <LocalAuthRouter component={View} />,
            pageHtml$,
        ),
        [OAUTH2_SIGNIN_ENDPOINT_NAME]: new OAuth2SignInController(),
        [OAUTH2_SIGNOUT_ENDPOINT_NAME]: new OAuth2SignOutController(),
        [OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedInController(),
        [OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedOutController(),
        [LOCAL_UPLOAD_ENDPOINT_NAME]: new LocalUploadController(uploadDirPath),
    });
}

export function getDatabase(): Database | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('_db').default;
    } catch {
        return null;
    }
}
