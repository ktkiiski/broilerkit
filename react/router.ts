import { ComponentClass, ReactNode } from 'react';
import { AuthClient, AuthUser } from '../auth';
import { Router } from '../routing';
import { renderObservable, renderObservableWithUser } from './observer';

export interface SimpleRenderRouterWithPropsOptions<S, P> {
    router: Router<S>;
    renderers: {[K in keyof S]?: (params: S[K], props: P) => ReactNode};
    default?: (props: P) => ReactNode;
}

export interface SimpleRenderRouterOptions<S> {
    router: Router<S>;
    renderers: {[P in keyof S]?: (params: S[P]) => ReactNode};
    default?: () => ReactNode;
}

export interface UserRenderRouterOptions<S, P> {
    auth: AuthClient;
    router: Router<S>;
    renderers: {[K in keyof S]?: (params: S[K], user: AuthUser | null, props: P) => ReactNode};
    default?: (props: P) => ReactNode;
}

export function renderRoute<S>(router: Router<S>) {
    function withDefault<D>(defaultRenderer: (props: D) => ReactNode) {
        function withStatesAndDefault<P>(renderers: {[K in keyof S]?: (params: S[K], props: P) => ReactNode}) {
            return renderRouteWithOptions<S, P & D>({router, renderers, default: defaultRenderer});
        }
        return {withStates: withStatesAndDefault};
    }
    function withStates<P>(renderers: {[K in keyof S]?: (params: S[K], props: P) => ReactNode}) {
        return renderRouteWithOptions({router, renderers});
    }
    return {withStates, withDefault};
}

function renderRouteWithOptions<S, P>(options: SimpleRenderRouterWithPropsOptions<S, P>): ComponentClass<P> {
    const defaultRenderer = options && options.default;
    return renderObservable({
        observable: options.router,
        render: (state, props) => {
            if (state) {
                const {name, params} = state;
                const render = options.renderers[name];
                if (render) {
                    return render(params, props);
                }
            }
            return defaultRenderer ? defaultRenderer(props) : null;
        },
    });
}

export function renderRouteWithUser<S, P>(options: UserRenderRouterOptions<S, P>): ComponentClass<P> {
    const defaultRenderer = options && options.default;
    return renderObservableWithUser({
        auth: options.auth,
        observable: () => options.router,
        render: (state, user, props: P) => {
            if (state) {
                const {name, params} = state;
                const render = options.renderers[name];
                if (render) {
                    return render(params, user, props);
                }
            }
            return defaultRenderer ? defaultRenderer(props) : null;
        },
    });
}
