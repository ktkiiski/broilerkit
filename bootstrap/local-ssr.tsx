import * as React from 'react';
import authLocalServer from '../auth-local-server';
import { HttpRequest } from '../http';
import LocalAuthRouter from '../react/components/LocalAuthRouter';
import { ApiService } from '../server';
import { renderView } from '../ssr';

export default async (req: HttpRequest, pageHtml: string) => {
    // Load the module exporting the rendered React component
    const siteModule = require('_site');
    const view: React.ComponentType<{}> = siteModule.default;
    return await renderView(
        req, pageHtml,
        () => (<LocalAuthRouter component={view} />),
        () => {
            const apiService: ApiService = require('_service').default;
            return apiService.extend(authLocalServer);
        },
    );
};
