import { Auth, AuthClient } from '../auth';
import { useClient } from './client';
import { useObservable } from './rxjs';

export function useAuth(): Auth | null | undefined {
    const {authClient} = useClient();
    return useObservable(
        // TODO: Provide auth as initial value when the SSR is aware of the authentication!
        // authClient && authClient.getAuthentication(),
        undefined,
        () => validateAuthClient(authClient).auth$,
        [authClient],
    );
}

export function useUserId(): string | null | undefined {
    const {authClient} = useClient();
    // TODO: Provide auth as initial value when the SSR is aware of the authentication!
    // const initAuth = authClient && authClient.getAuthentication();
    return useObservable(
        undefined,
        () => validateAuthClient(authClient).userId$,
        [authClient],
    );
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
