import isEqual from 'immuton/isEqual';
import { useEffect, useState } from 'react';
import type { Auth, AuthClient, AuthIdentityProvider } from '../auth';
import { useClient } from './client';

export function useAuth(): Auth | null {
    const client = useClient();
    const authClient = validateAuthClient(client.authClient);
    const [auth, setAuth] = useState<Auth | null>(authClient.getAuthentication());
    useEffect(
        () =>
            authClient.subscribeAuthentication((newAuth) => {
                setAuth((prevAuth) => (isEqual(newAuth, prevAuth, 1) ? prevAuth : newAuth));
            }),
        [authClient],
    );
    return auth;
}

export function useUserId(): string | null {
    const client = useClient();
    const authClient = validateAuthClient(client.authClient);
    const initAuth = authClient.getAuthentication();
    const [userId, setUserId] = useState<string | null>(initAuth && initAuth.id);
    useEffect(
        () =>
            authClient.subscribeAuthentication((auth) => {
                const newUserId = auth && auth.id;
                setUserId(newUserId);
            }),
        [authClient],
    );
    return userId;
}

export function useSignIn(): (provider: AuthIdentityProvider) => Promise<Auth> {
    const client = useClient();
    const authClient = validateAuthClient(client.authClient);
    return authClient.signIn;
}

export function useSignOut(): () => Promise<void> {
    const client = useClient();
    const authClient = validateAuthClient(client.authClient);
    return authClient.signOut;
}

function validateAuthClient(authClient?: AuthClient | null): AuthClient {
    if (!authClient) {
        throw new Error(`Authentication client not defined!`);
    }
    return authClient;
}
