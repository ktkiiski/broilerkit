import * as React from 'react';
import { Redirect, useLocation } from 'react-router-dom';
import { parseQuery } from '../../url';

function LocalSignOutView(): JSX.Element {
    const location = useLocation();
    const query = parseQuery(location.search);
    return <Redirect to={query.logout_uri} />;
}

export default LocalSignOutView;
