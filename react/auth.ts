import { useEffect, useState } from 'react';
import { Auth, AuthClient } from '../auth';
import { isEqual } from '../utils/compare';
import { useClient } from './client';

export function useAuth(): Auth | null | undefined {
    const {authClient} = useClient();
    // TODO: Provide auth as initial value when the SSR is aware of the authentication!
    const [auth, setAuth] = useState(undefined as Auth | null | undefined);
    useEffect(() => {
        return validateAuthClient(authClient).subscribeAuthentication((newAuth) => {
            if (!isEqual(newAuth, auth, 1)) {
                setAuth(newAuth);
            }
        });
    }, [authClient]);
    return auth;
}

export function useUserId(): string | null | undefined {
    const {authClient} = useClient();
    // TODO: Provide auth as initial value when the SSR is aware of the authentication!
    const [userId, setUserId] = useState(undefined as string | null | undefined);
    useEffect(() => {
        return validateAuthClient(authClient).subscribeAuthentication((auth) => {
            const newUserId = auth && auth.id;
            if (!isEqual(newUserId, userId, 1)) {
                setUserId(newUserId);
            }
        });
    }, [authClient]);
    return userId;
}

export function useRequireAuth(): () => Promise<Auth> {
    const {authClient} = useClient();
    return () => validateAuthClient(authClient).demandAuthentication();
}

export function useSignIn(): () => Promise<Auth> {
    const {authClient} = useClient();
    return () => validateAuthClient(authClient).signIn();
}

export function useSignOut(): () => Promise<null> {
    const {authClient} = useClient();
    return () => validateAuthClient(authClient).signOut();
}

function validateAuthClient(authClient?: AuthClient | null): AuthClient {
    if (!authClient) {
        throw new Error(`Authentication client not defined!`);
    }
    return authClient;
}
