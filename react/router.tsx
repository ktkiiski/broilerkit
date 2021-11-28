/* eslint-disable react/jsx-no-bind */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { Route as ReactRoute, RouteComponentProps } from 'react-router-dom';
import { HttpStatus, isErrorResponse } from '../http';
import type { Route } from '../routes';

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
    errorComponent?: React.ComponentType<any> | null,
    statusCode = HttpStatus.OK,
): JSX.Element {
    const { pattern } = route.pattern;
    const pathPattern = pattern.replace(/\{(\w+)\}/g, (_, urlKeyword: string) => `:${urlKeyword}`);
    function RoutedComponent(props: RouteComponentProps<{ url: string }>) {
        const { match } = props;
        try {
            const routeMatch = route.match(match.url);
            if (routeMatch) {
                setStatusCode(props, statusCode);
                return React.createElement(component, { ...routeMatch, ...props });
            }
            setStatusCode(props, HttpStatus.NotFound);
        } catch (error) {
            // Show the error component on a validation error, otherwise pass through
            if (!isErrorResponse(error)) {
                throw error;
            }
            setStatusCode(props, error.statusCode);
        }
        if (!errorComponent) {
            return null;
        }
        return React.createElement(errorComponent, props);
    }
    return <ReactRoute exact sensitive path={pathPattern} component={RoutedComponent} />;
}

export function renderStaticRoute(component: React.ComponentType, statusCode = HttpStatus.OK): JSX.Element {
    function RoutedComponent(props: RouteComponentProps<any>) {
        setStatusCode(props, statusCode);
        return React.createElement(component);
    }
    return <ReactRoute component={RoutedComponent} />;
}

function setStatusCode({ staticContext }: RouteComponentProps<any>, statusCode: HttpStatus) {
    if (staticContext) {
        staticContext.statusCode = statusCode;
    }
}
