import * as React from 'react';
import { Route, Switch } from 'react-router-dom';
import { useCss } from '../meta';
import LocalSignInView from './LocalSignInView';
import LocalSignOutView from './LocalSignOutView';

function LocalAuthRouter(props: { component: React.ComponentType }) {
    const { component } = props;
    useCss(() => `body { padding: 0; margin: 0; }`, []);
    return (
        <Switch>
            <Route exact path="/_oauth2_signin" component={LocalSignInView} />
            <Route exact path="/_oauth2_signout" component={LocalSignOutView} />
            <Route component={component} />
        </Switch>
    );
}

export default React.memo(LocalAuthRouter);
