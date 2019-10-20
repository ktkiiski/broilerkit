import { sign } from 'jsonwebtoken';
import * as React from 'react';
import { useState } from 'react';
import { RouteComponentProps, withRouter } from 'react-router';
import * as api from '../../auth-local-api';
import { buildQuery, parseQuery } from '../../url';
import { User } from '../../users';
import { randomize } from '../../utils/strings';
import { useList, useOperation } from '../api';

function LocalSignInView({location}: RouteComponentProps) {
    const [isAdmin, setIsAdmin] = useState(false);
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [hasAvatar, setHasAvatar] = useState(true);
    const createUserOperation = useOperation(api._createUser);
    const signUp = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const avatarHash = randomize(32, '01234567890abcdef');
        const picture = hasAvatar ? `https://www.gravatar.com/avatar/${avatarHash}?d=wavatar` : null;
        const user = await createUserOperation.post({email, name, picture});
        await signInAs(user);
    };
    const [users] = useList(api._listUsers, {
        ordering: 'name',
        direction: 'asc',
    });
    const query = parseQuery(location.search);

    async function signInAs(user: User) {
        const accessTokenPayload = {
            sub: user.id,
            exp: Math.floor(new Date().getTime() / 1000) + 60 * 60,
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
        const code = buildQuery({ id_token: idToken, access_token: accessToken });
        const redirectQuery = buildQuery({code, state: query.state});
        window.location.href = `${query.redirect_uri}?${redirectQuery}`;
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

export default withRouter(LocalSignInView);
