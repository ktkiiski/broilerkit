import { never } from 'rxjs';
import { Auth, AuthClient } from '../auth';
import { useClient, useWithClient } from './client';
import { useObservable } from './rxjs';

const nothing$ = never();

export function useAuth(): Auth | null | undefined {
    const client = useClient();
    return useObservable(
        undefined, () => {
            if (!client) {
                // Client not yet available
                return nothing$;
            }
            const {authClient} = client;
            if (!authClient) {
                throw new Error(`Authentication client not defined!`);
            }
            return authClient.auth$;
        },
        [client],
    );
}

export function useUserId(): string | null | undefined {
    const auth = useAuth();
    return auth && auth.id;
}

export function useAuthClient<R, P extends any[]>(
    callback: (authClient: AuthClient, ...args: P) => R,
): (...args: P) => R {
    return useWithClient((client, ...args: P) => {
        const authClient = client && client.authClient;
        if (!authClient) {
            throw new Error(`Authentication client not defined!`);
        }
        return callback(authClient, ...args);
    });
}
