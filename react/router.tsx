import * as React from 'react';
import { Route as ReactRoute, RouteComponentProps } from 'react-router';
import { isErrorResponse } from '../http';
import { Route } from '../routes';
import { spread } from '../utils/objects';

/**
 * Returns a Route component from 'react-router-dom' that will render the given component
 * based on a URL route definition, which in addition to the path also handles URL parameters
 * and parameter validation. Use the return value in the `render` methods wherever you would
 * use a `<Route>`.
 *
 * @param route Check the URL against this route
 * @param component Render this component if the route matches
 * @param errorComponent Show this component if the route path matches but there is a validation error
 */
export function renderRoute<S>(
    route: Route<S, never> | Route<S, any>,
    component: React.ComponentType<S>,
    errorComponent?: React.ComponentType<any>,
) {
    const { pattern } = route.pattern;
    const pathPattern = pattern.replace(/\{(\w+)\}/g, (_, urlKeyword: string) => `:${urlKeyword}`);
    const routedComponent = (props: RouteComponentProps<any>) => {
        const { match } = props;
        try {
            const routeMatch = route.match(match.url);
            if (routeMatch) {
                return React.createElement(component, spread(routeMatch, props));
            }
        } catch (error) {
            // Show the error component on a validation error, otherwise pass through
            if (!isErrorResponse(error)) {
                throw error;
            }
        }
        if (!errorComponent) {
            return null;
        }
        return React.createElement(errorComponent, props);
    };
    return React.createElement(ReactRoute, {
        exact: true,
        sensitive: true,
        path: pathPattern,
        component: routedComponent,
    });
}
