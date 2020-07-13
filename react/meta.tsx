import * as React from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';

export interface MetaContext {
    title?: string;
    styles?: Record<string, () => string | null>;
    idCounter: number;
}

const StaticContextContext = createContext<MetaContext>({
    idCounter: 0,
});

export function MetaContextProvider(props: {context: MetaContext, children?: React.ReactNode}): JSX.Element {
    return (
        <StaticContextContext.Provider value={props.context}>
            {props.children}
        </StaticContextContext.Provider>
    );
}

export function useTitle(title: string): void {
    const metaContext = useContext(StaticContextContext);
    if (typeof document !== 'undefined') {
        document.title = title;
    }
    if (metaContext) {
        metaContext.title = title;
    }
}

export function useCss(renderCss: () => string | null, deps?: unknown[]): void {
    const metaContext = useContext(StaticContextContext);
    const id = useMemo(
        () => `style-${metaContext.idCounter++}`,
        [metaContext],
    );
    useEffect(() => {
        if (!id) {
            return;
        }
        const css = renderCss();
        let styleTag: HTMLStyleElement | null = null;
        if (typeof document !== 'undefined' && document && document.head) {
            // Running on the client-size
            // TODO: Do not remove and re-add style tags when changed!
            const existingStyleTag = document.getElementById(id) as HTMLStyleElement | null;
            styleTag = existingStyleTag;
            if (css) {
                styleTag = styleTag || document.createElement('style');
                styleTag.type = 'text/css';
                styleTag.id = id;
                if (existingStyleTag) {
                    styleTag.innerHTML = '';
                }
                styleTag.appendChild(document.createTextNode(css));
                if (!existingStyleTag) {
                    document.head.appendChild(styleTag);
                }
            } else {
                // If the DOM was added by server-side, remove it!
                removeNode(existingStyleTag);
            }
        }
        return () => {
            // Remove the style node from DOM
            removeNode(styleTag);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps && [id, ...deps]);

    if (metaContext.styles && id) {
        metaContext.styles[id] = renderCss;
    }
}

function removeNode(node: Node | null) {
    if (node) {
        const parent = node.parentNode;
        if (parent) {
            parent.removeChild(node);
        }
    }
}
