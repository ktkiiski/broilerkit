import * as React from 'react';
import { HttpRequest } from '../http';
import LocalAuthRouter from '../react/components/LocalAuthRouter';
import { renderView } from '../ssr';

export default async (req: HttpRequest, pageHtml: string) => {
    // Load the module exporting the rendered React component
    const siteModule = require('_site');
    const view: React.ComponentType<{}> = siteModule.default;
    return await renderView(
        req, pageHtml,
        () => (<LocalAuthRouter component={view} />),
        () => require('_service').default,
    );
};
