import { datetime, email, list, nullable, string, url } from './fields';
import { serializer } from './serializers';

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

    private readonly signInUri = '/oauth2/sign_in';
    private readonly signOutUri = '/oauth2/sign_out';
    private auth!: Auth | null;
    private authExpirationTimeout?: any;

    private authListeners: Array<(auth: Auth | null) => void> = [];

    constructor(initialAuth: Auth | null) {
        this.setAuthentication(initialAuth);
    }

    /**
     * Starts authentication flow by redirecting the user to the sign in URL.
     *
     * Because this will change window location, only call this in a `click` event handler.
     *
     * When to call this:
     * - User clicks the "Sign in" button
     *
     * @param identityProvider Optional name of the provider to use when logging in
     */
    public async signIn(identityProvider?: AuthIdentityProvider): Promise<never> {
        const redirectUri = window.location.href;
        let signInUri = `${this.signInUri}?redirect_uri=${encodeURIComponent(redirectUri)}`;
        if (identityProvider) {
            signInUri += `&identity_provider=${encodeURIComponent(identityProvider)}`;
        }
        window.location.href = signInUri;
        await new Promise((resolve) => {
            setTimeout(resolve, 10000);
        });
        throw new Error('Redirecting to authentication URL timed out');
    }

    /**
     * Starts the sign out flow by redirecting the user to the sign out page.
     *
     * Because this will redirect the user, only call this in a `click` event handler.
     *
     * When to call this:
     * - User clicks the "Sign out" button
     */
    public async signOut(): Promise<never> {
        this.setAuthentication(null);
        const redirectUri = window.location.href;
        const signOutUri = `${this.signOutUri}?redirect_uri=${encodeURIComponent(redirectUri)}`;
        window.location.href = signOutUri;
        await new Promise((resolve) => {
            setTimeout(resolve, 10000);
        });
        throw new Error('Redirecting to sign out URL timed out');
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
}
