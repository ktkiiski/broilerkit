import * as React from 'react';
import { Route, Switch } from 'react-router';
import LocalSignInView from './LocalSignInView';
import LocalSignOutView from './LocalSignOutView';

function LocalAuthRouter(props: {component: React.ComponentType}) {
    return (
        <Switch>
            <Route exact path='/_oauth2_signin' component={LocalSignInView} />
            <Route exact path='/_oauth2_signout' component={LocalSignOutView} />
            <Route component={props.component} />
        </Switch>
    );
}

export default React.memo(LocalAuthRouter);
