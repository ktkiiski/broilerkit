import * as React from 'react';
import { Redirect, withRouter } from 'react-router';
import { parseQuery } from '../../url';

export default withRouter(({ location }) => {
    const query = parseQuery(location.search);
    return <Redirect to={query.logout_uri} />;
});
