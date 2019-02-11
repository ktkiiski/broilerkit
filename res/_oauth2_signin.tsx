import { sign } from 'jsonwebtoken';
import { useState } from 'react';
import * as React from 'react';
import { render } from 'react-dom';
import * as api from '../auth-local-api';
import { Client } from '../client';
import { useList, useOperation } from '../react/api';
import { ClientProvider } from '../react/client';
import { parseQuery } from '../url';
import { User } from '../users';
import { randomize } from '../utils/strings';

declare const __API_ROOT__: string;

const query = parseQuery(window.location.search || '');
const client = new Client(__API_ROOT__);

function Signin() {
    const [isAdmin, setIsAdmin] = useState(false);
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [hasAvatar, setHasAvatar] = useState(true);
    const signUp = useOperation(api._createUser, async (op, event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const avatarHash = randomize(32, '01234567890abcdef');
        const picture = hasAvatar ? `https://www.gravatar.com/avatar/${avatarHash}?d=wavatar` : null;
        const user = await op.post({email, name, picture});
        await signInAs(user);
    });
    const users = useList(api._listUsers, {
        ordering: 'name',
        direction: 'asc',
    });

    async function signInAs(user: User) {
        const accessTokenPayload = {
            sub: user.id,
            exp: +new Date() + 1000 * 60 * 60,
        };
        const idTokenPayload = {
            ...accessTokenPayload,
            'email': user.email,
            'name': user.name,
            'picture': user.picture,
            'cognito:groups': isAdmin ? ['Administrators'] : [],
        };
        // Create the JWT token
        const accessToken = sign(accessTokenPayload, 'LOCAL_SECRET');
        const idToken = sign(idTokenPayload, 'LOCAL_SECRET');
        window.location.href = `${query.redirect_uri}#access_token=${accessToken}&id_token=${idToken}&state=${query.state}`;
    }

    return <>
        <h1>Log in</h1>
        <p>
            <label>
                <input
                    type='checkbox'
                    checked={isAdmin}
                    onChange={(event) => setIsAdmin(event.target.checked)}
                />
                Log in as an admin
            </label>
        </p>
        <h4>Sign up as a new user</h4>
        <form onSubmit={signUp}>
            <div><label>Email</label></div>
            <div>
                <input
                    type='email'
                    placeholder='Type an unique email address'
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                />
            </div>
            <div><label>Name</label></div>
            <div>
                <input
                    type='text'
                    placeholder='Type the full name'
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                />
            </div>
            <div>
                <label>
                    <input
                        type='checkbox'
                        checked={hasAvatar}
                        onChange={(event) => setHasAvatar(event.target.checked)}
                        id='avatar-checkbox'
                    />
                    Has avatar
                </label>
            </div>
            <div>
                <button type='submit'>Sign up</button>
            </div>
        </form>
        <hr/>
        <h4>Sign in with an existing user</h4>
        {users && users.map((user) => (
            <button key={user.id} onClick={() => signInAs(user)}>
            {user.name}
            ({user.email})
            </button>
        ))}
    </>;
}

render(
    <ClientProvider client={client}>
        <Signin />
    </ClientProvider>,
    document.getElementById('root'),
);
