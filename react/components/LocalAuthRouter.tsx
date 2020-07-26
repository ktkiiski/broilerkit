import * as React from 'react';
import { Route, Switch } from 'react-router-dom';
import LocalSignInView from './LocalSignInView';
import LocalSignOutView from './LocalSignOutView';

function LocalAuthRouter(props: { component: React.ComponentType }) {
    const { component } = props;
    return (
        <Switch>
            <Route exact path="/_oauth2_signin" component={LocalSignInView} />
            <Route exact path="/_oauth2_signout" component={LocalSignOutView} />
            <Route component={component} />
        </Switch>
    );
}

export default React.memo(LocalAuthRouter);
