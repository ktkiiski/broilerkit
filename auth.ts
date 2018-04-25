import { parseJwt } from './jwt';
import { parseQuery } from './url';
import { randomize, stripPrefix } from './utils/strings';
import { waitForClose } from './window';

export interface AuthTokens {
    accessToken: string;
    idToken: string;
}

export interface Auth extends AuthTokens {
    id: string;
    email: string;
    name?: string;
    expiresAt: Date;
}

export type AuthSubscriber = (auth: Auth | null) => void;
export type AuthIdentityProvider = 'Facebook' | 'Google';
export interface AuthOptions {
    clientId: string;
    signInUri: string;
    signOutUri: string;
    signInRedirectUri: string;
    signOutRedirectUri: string;
}

export class AuthClient {

    private readonly signInUri: string;
    private readonly signOutUri: string;

    private auth: Auth | null = null;
    private observers: AuthSubscriber[] = [];

    constructor(options: AuthOptions) {
        const {clientId, signInUri, signOutUri, signInRedirectUri, signOutRedirectUri} = options;
        this.signInUri = signInUri
            + '?redirect_uri=' + encodeURIComponent(signInRedirectUri)
            + '&client_id=' + encodeURIComponent(clientId)
            + '&response_type=token';
        this.signOutUri = signOutUri
            + '?logout_uri=' + encodeURIComponent(signOutRedirectUri)
            + '&client_id=' + encodeURIComponent(clientId)
            + '&response_type=token';
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
     * - Token has expired and the login should be refreshed
     *
     * @param identityProvider Optional name of the provider to use when logging in
     */
    public async authenticate(identityProvider?: AuthIdentityProvider): Promise<Auth> {
        const state = randomize(24);
        const signInUri = this.getSignInUri(state, identityProvider);
        const dialog = this.launchUri(signInUri);
        try {
            const accessToken = await this.waitForSignInPostMessage(dialog, state);
            return this.setTokens(accessToken);
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
     * Deletes any tokens from the memory and the storage.
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
    public async signOut(): Promise<null> {
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
        return this.setTokens(null);
    }

    /**
     * Use this method to get the access token right before making an
     * API request to the server, to be included to the Authorization header.
     *
     * If the user is not authenticated, or any previous token has expired,
     * (i.e. there is no valid access token stored), the user will be signed in.
     * Because this may open a pop-up, only call this in a `click` event handler,
     * to prevent pop-up blockers to prevent the window to be opened.
     */
    public async demandAccessToken(): Promise<string> {
        const token = this.getAccessToken();
        if (token) {
            return token;
        }
        const auth = await this.authenticate();
        return auth.accessToken;
    }

    /**
     * Use this method to get the identity token right before making an
     * API request to the server, to be included to the Authorization header.
     *
     * If the user is not authenticated, or any previous token has expired,
     * (i.e. there is no valid identity token stored), the user will be signed in.
     * Because this may open a pop-up, only call this in a `click` event handler,
     * to prevent pop-up blockers to prevent the window to be opened.
     */
    public async demandIdToken(): Promise<string> {
        const token = this.getIdToken();
        if (token) {
            return token;
        }
        const auth = await this.authenticate();
        return auth.idToken;
    }

    /**
     * Returns the current access token if the user is authenticated and the token
     * has not expired yet. Otherwise returns null.
     */
    public getAccessToken(now = new Date()): string | null {
        const auth = this.auth;
        return auth && now < auth.expiresAt && auth.accessToken || null;
    }

    /**
     * Returns the current identity token if the user is authenticated and the token
     * has not expired yet. Otherwise returns null.
     */
    public getIdToken(now = new Date()): string | null {
        const auth = this.auth;
        return auth && now < auth.expiresAt && auth.idToken || null;
    }

    /**
     * Returns the current authentication state if the user is authenticated.
     * The access token may or may not be expired. If not signed in, returns null.
     */
    public getAuthentication(): Auth | null {
        return this.auth;
    }

    /**
     * Observe the currently authenticated user.
     * The given callback will be called with the current authentication
     * state immediately, and then whenever the state changes.
     *
     * The state can be:
     * - `null` if the user is not signed in
     * - an object if the user is signed in, with the following attributes:
     *      - `id`: an unique ID of the user
     *      - `name`: the name of the user
     *      - `email`: email of the user
     *      - `accessToken`: the latest access token (which may or may not be expired)
     *
     * This returns a function that when called, will cancel the observation,
     * ensuring that the callback will no more be called.
     *
     * Use this to:
     * - Render and switch between "Sign in" and "Sign out" button in the UI
     * - Render the user's name or email in the UI
     */
    public observeAuthentication(callback: AuthSubscriber): () => void {
        const {observers} = this;
        observers.push(callback);
        return () => {
            const index = observers.indexOf(callback);
            if (index >= 0) {
                observers.splice(index, 1);
            }
        };
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

    private waitForSignInPostMessage(win: Window, requiredState: string): Promise<AuthTokens> {
        return new Promise<AuthTokens>((resolve, reject) => {
            const listener = (event: MessageEvent) => {
                if (event.origin !== window.location.origin) {
                    // Message is from unknown origin
                    return;
                }
                const resultStr = stripPrefix(String(event.data), '[oauth2]:signin:');
                if (!resultStr) {
                    return;
                }
                // Some result available, failed or not. No need to listen postMessages any more
                window.removeEventListener('message', listener);

                try {
                    const {error, state, access_token, id_token} = parseQuery(resultStr.replace(/^#/, ''));
                    // Check that no error attribute is present
                    if (error) {
                        throw new Error(`Authentication failed due to '${error}'`);
                    }
                    // The access token must be present
                    if (!access_token) {
                        throw new Error(`Authentication failed due to missing access token`);
                    }
                    // The ID token token must be present
                    if (!id_token) {
                        throw new Error(`Authentication failed due to missing ID token`);
                    }
                    // The state parameter must equal to the original
                    if (state !== requiredState) {
                        throw new Error(`Authentication resulted in invalid state: suspecting a cross-site forgery attempt`);
                    }
                    resolve({accessToken: access_token, idToken: id_token});
                } catch (err) {
                    reject(err);
                }
            };
            window.addEventListener('message', listener);
            waitForClose(win).then(() => {
                window.removeEventListener('message', listener);
                reject(new Error(`Authentication failed due to closed window`));
            });
        });
    }

    private waitForSignOutPostMessage(win: Window): Promise<void> {
        return new Promise<void>((resolve) => {
            const listener = (event: MessageEvent) => {
                if (event.origin !== window.location.origin) {
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

    private setTokens(tokens: null): null;
    private setTokens(tokens: AuthTokens): Auth;
    private setTokens(tokens: AuthTokens | null): Auth | null {
        const auth = this.auth = tokens && parseAuth(tokens);
        // Call each observer
        Promise.resolve(auth).then((a) => {
            for (const observer of this.observers) {
                observer(a);
            }
        });
        return auth;
    }
}

function parseAuth(tokens: AuthTokens) {
    const idTokenPayload = parseJwt(tokens.idToken);
    const accesTokenPayload = parseJwt(tokens.accessToken);
    const exp = Math.min(idTokenPayload.exp, accesTokenPayload.exp);
    const userId = idTokenPayload.sub || accesTokenPayload.sub;
    return {
        id: userId,
        name: idTokenPayload.name,
        email: idTokenPayload.email,
        expiresAt: new Date(exp * 1000),
        ...tokens,
    };
}
