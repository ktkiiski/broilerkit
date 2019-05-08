import { UserInfo } from 'firebase';
import { useEffect, useState } from 'react';
import { useFirebaseAuth } from './firebase';

export function useAuth(): UserInfo | null | undefined {
    const authClient = useFirebaseAuth();
    // TODO: Provide auth as initial value when the SSR is aware of the authentication!
    const [authState, setAuthState] = useState(undefined as UserInfo | null | undefined);
    useEffect(() => (
      authClient.onAuthStateChanged((user) => {
        setAuthState(user);
      })
    ), [authClient]);
    return authState;
}

export function useUserId(): string | null | undefined {
    const auth = useFirebaseAuth();
    // TODO: Provide auth as initial value when the SSR is aware of the authentication!
    const [userId, setUserId] = useState(undefined as string | null | undefined);
    useEffect(() => (
        auth.onAuthStateChanged((user) => {
          setUserId(user && user.uid);
        })
      ), [auth]);
    return userId;
}
