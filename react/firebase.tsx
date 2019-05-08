// tslint:disable:no-import-side-effect
import { app, auth, firestore, initializeApp } from 'firebase';
import 'firebase/auth';
import 'firebase/firestore';
import * as React from 'react';
import { useContext } from 'react';

interface Services {
  firebase: app.App;
  firestore: firestore.Firestore;
  auth: auth.Auth;
}

const FirebaseContext = React.createContext<Services | null>(null);

function useServices(): Services {
  const value = useContext(FirebaseContext);
  if (!value) {
    throw new Error(`Firebase not provided!`);
  }
  return value;
}

export function useFirebase() {
  return useServices().firebase;
}

export function useFirestore() {
  return useServices().firestore;
}

export function useFirebaseAuth() {
  return useServices().auth;
}

interface FirebaseProviderProps {
  config: object;
  children: React.ReactNode;
}

export function FirebaseProvider(props: FirebaseProviderProps) {
  const services = React.useMemo(
    () => {
      const firebase = initializeApp(props.config);
      // tslint:disable-next-line:no-shadowed-variable
      const firestore = firebase.firestore();
      // tslint:disable-next-line:no-shadowed-variable
      const auth = firebase.auth();
      return { firebase, firestore, auth };
    },
    // TODO: Use each known configuration property as dependency for efficiency!
    [JSON.stringify(props.config)],
  );
  return <FirebaseContext.Provider value={services}>
    {props.children}
  </FirebaseContext.Provider>;
}
