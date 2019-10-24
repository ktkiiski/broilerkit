import { datetime, email, list, nullable, string, url } from './fields';
import { serializer } from './serializers';
import { randomize, stripPrefix } from './utils/strings';
import { waitForClose } from './window';

export interface Auth {
    id: string;
    email: string | null;
    picture: string | null;
    name: string | null;
    groups: string[];
    expiresAt: Date;
}

export const authSerializer = serializer({
    id: string(),
    email: nullable(email()),
    picture: nullable(url()),
    name: nullable(string()),
    groups: list(string()),
    expiresAt: datetime(),
});

export type AuthSubscriber = (auth: Auth | null) => void;
export type AuthIdentityProvider = 'Facebook' | 'Google';
export interface AuthOptions {
    clientId: string;
    signInUri: string;
    signOutUri: string;
    signInRedirectUri: string;
    signOutRedirectUri: string;
    auth: Auth | null;
}

export interface AuthClient {
    signIn(identityProvider?: AuthIdentityProvider): Promise<Auth>;
    signOut(): Promise<void>;
    demandAuthentication(): Promise<Auth>;
    getAuthentication(): Auth | null;
    subscribeAuthentication(fn: (auth: Auth | null) => void): () => void;
}

export class DummyAuthClient implements AuthClient {
    constructor(private readonly auth: Auth | null) {}
    public signIn(): never {
        throw new Error('Signing in not supported');
    }
    public signOut(): never {
        throw new Error('Signing in not supported');
    }
    public demandAuthentication(): never {
        throw new Error('Demanding authentication not supported');
    }
    public getAuthentication(): Auth | null {
        return this.auth;
    }
    public subscribeAuthentication(): never {
        throw new Error('Authentication cannot be subscribed');
    }
}

export class BrowserAuthClient implements AuthClient {

    private readonly signInUri: string;
    private readonly signOutUri: string;
    private readonly signInRedirectUri: string;
    private readonly signOutRedirectUri: string;
    private auth!: Auth | null;
    private authExpirationTimeout?: any;

    private authListeners: Array<(auth: Auth | null) => void> = [];

    constructor(options: AuthOptions) {
        const {clientId, signInUri, signOutUri, signInRedirectUri, signOutRedirectUri} = options;
        this.signInRedirectUri = signInRedirectUri;
        this.signOutRedirectUri = signOutRedirectUri;
        this.signInUri = signInUri
            + '?redirect_uri=' + encodeURIComponent(signInRedirectUri)
            + '&client_id=' + encodeURIComponent(clientId)
            + '&response_type=code';
        this.signOutUri = signOutUri
            + '?logout_uri=' + encodeURIComponent(signOutRedirectUri)
            + '&client_id=' + encodeURIComponent(clientId);
        this.setAuthentication(options.auth);
    }

    /**
     * Ensures that the user is logged in.
     * Shows the login popup window if the user is not logged in,
     * or refreshes the authentication.
     *
     * Because this may open a pop-up, only call this in a `click` event handler,
     * to prevent pop-up blockers to prevent the window to be opened.
     *
     * When to call this:
     * - User clicks the "Sign in" button
     *
     * @param identityProvider Optional name of the provider to use when logging in
     */
    public async signIn(identityProvider?: AuthIdentityProvider): Promise<Auth> {
        const state = randomize(24);
        const signInUri = this.getSignInUri(state, identityProvider);
        const dialog = this.launchUri(signInUri);
        try {
            const auth = await this.waitForSignInPostMessage(dialog, state);
            this.setAuthentication(auth);
            return auth;
        } finally {
            try {
                dialog.close();
            } catch {
                // Maybe already closed. Ignore the error
            }
        }
    }

    /**
     * Ensures that the user is logged out.
     * Shortly opens a popup and redirects through the authorization
     * server and ensures that next time authentication attempt is made,
     * the user will be prompted to sign in again.
     *
     * Because this may open a pop-up, only call this in a `click` event handler,
     * to prevent pop-up blockers to prevent the window to be opened.
     *
     * When to call this:
     * - User clicks the "Sign out" button
     */
    public async signOut(): Promise<void> {
        const dialog = this.launchUri(this.signOutUri);
        // Open the dialog for signing out from the authentication service
        // NOTE: No need to wait until this is done
        this.waitForSignOutPostMessage(dialog).then(() => {
            try {
                dialog.close();
            } catch {
                // Maybe already closed. Ignore the error
            }
        });
        this.setAuthentication(null);
    }

    /**
     * Ensures that the user is signed in. If not, then they will be asked
     * to sign in. If already signed in, then the current authentication status
     * is resolved.
     */
    public async demandAuthentication(): Promise<Auth> {
        const auth = this.getAuthentication();
        if (auth) {
            return auth;
        }
        return this.signIn();
    }

    /**
     * Returns the current authentication state if the user is authenticated.
     * If not signed in, returns null.
     *
     * The returned value can be:
     * - `null` if the user is not signed in
     * - `undefined` if the authentication status is not yet known
     * - an object if the user is signed in, with the following attributes:
     *      - `id`: an unique ID of the user
     *      - `name`: the name of the user
     *      - `email`: email of the user
     *      - `picture`: URL of the profile picture of the user
     */
    public getAuthentication() {
        return this.auth;
    }

    /**
     * Subscribes to the authentication, calling the callback whenever
     * the authentication changes.
     */
    public subscribeAuthentication(fn: (auth: Auth | null) => void): () => void {
        const {authListeners} = this;
        // Wrap as a async function to avoid rising errors through
        async function listener(auth: Auth | null) {
            fn(auth);
        }
        listener(this.getAuthentication());
        authListeners.push(listener);
        return () => {
            const listeners = authListeners.slice();
            const index = listeners.indexOf(listener);
            if (index >= 0) {
                listeners.splice(index, 1);
            }
            this.authListeners = listeners;
        };
    }

    private setAuthentication(auth: Auth | null) {
        if (this.authExpirationTimeout != null) {
            clearTimeout(this.authExpirationTimeout);
            delete this.authExpirationTimeout;
        }
        this.auth = auth;
        if (auth) {
            const now = new Date();
            const { expiresAt } = auth;
            const expiresIn = expiresAt.getTime() - now.getTime();
            // Clear authentication once expired
            this.authExpirationTimeout = setTimeout(() => {
                this.setAuthentication(null);
            }, expiresIn);
        }
        for (const listener of this.authListeners) {
            listener(this.auth);
        }
    }

    private launchUri(uri: string): Window {
        // We set the location for the popup after we create it to workaround
        // popup blockers that have a same-origin policy.
        const height = Math.min(480, window.innerHeight - 20);
        const width = Math.min(640, window.innerWidth - 20);
        const dialog = window.open('', 'oauth', `height=${height},width=${width}`) as Window;
        if (!dialog) {
            throw new Error(`Failed to open a window for the login`);
        }
        (dialog as any).location = uri;
        return dialog;
    }

    private async waitForSignInPostMessage(win: Window, requiredState: string): Promise<Auth> {
        const authMessage = await new Promise<string>((resolve, reject) => {
            const listener = (event: MessageEvent) => {
                if (this.signInRedirectUri.indexOf(`${event.origin}/`) !== 0) {
                    // Message is from unknown origin
                    return;
                }
                const resultStr = stripPrefix(String(event.data), '[oauth2]:signin:');
                if (!resultStr) {
                    return;
                }
                // Some result available, failed or not. No need to listen postMessages any more
                window.removeEventListener('message', listener);
                resolve(resultStr);
            };
            window.addEventListener('message', listener);
            waitForClose(win).then(() => {
                window.removeEventListener('message', listener);
                reject(new Error(`Authentication failed due to closed window`));
            });
        });
        const { error, error_description, state, auth } = JSON.parse(authMessage);
        // Check that no error attribute is present
        if (error) {
            if (error_description) {
                throw new Error(`Authentication failed: ${error_description}`);
            } else {
                throw new Error(`Authentication failed due to '${error}'`);
            }
        }
        // The state parameter must equal to the original
        if (state !== requiredState) {
            throw new Error(`Authentication resulted in invalid state: suspecting a cross-site forgery attempt`);
        }
        return authSerializer.deserialize(auth);
    }

    private waitForSignOutPostMessage(win: Window): Promise<void> {
        return new Promise<void>((resolve) => {
            const listener = (event: MessageEvent) => {
                if (this.signOutRedirectUri.indexOf(`${event.origin}/`) !== 0) {
                    // Message is from unknown origin
                    return;
                }
                const resultStr = event.data;
                if (resultStr === '[oauth2]:signout') {
                    window.removeEventListener('message', listener);
                    resolve();
                }
            };
            window.addEventListener('message', listener);
            waitForClose(win).then(() => {
                window.removeEventListener('message', listener);
                resolve();
            });
        });
    }

    private getSignInUri(state: string, identityProvider?: AuthIdentityProvider) {
        let uri = `${this.signInUri}&state=${encodeURIComponent(state)}`;
        if (identityProvider) {
            uri += `&identity_provider=${encodeURIComponent(identityProvider)}`;
        }
        return uri;
    }
}
