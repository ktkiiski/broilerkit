import { sign } from 'jsonwebtoken';
import * as React from 'react';
import { render } from 'react-dom';
import * as api from '../auth-local-api';
import { Client } from '../client';
import { ClientProvider, connect, ConnectedProps } from '../react/client';
import { parseQuery } from '../url';
import { User } from '../users';
import { randomize } from '../utils/strings';

declare const __API_ROOT__: string;

const query = parseQuery(window.location.search || '');
const client = new Client(__API_ROOT__);

const inject = connect({
    users: api._listUsers.all().with({
        ordering: 'name',
        direction: 'asc',
    }),
    createUser: api._createUser,
});

interface SigninState {
    isAdmin: boolean;
    name: string;
    email: string;
    hasAvatar: boolean;
}

class Signin extends React.PureComponent<ConnectedProps<typeof inject>, SigninState> {
    public state = {
        isAdmin: false,
        name: '',
        email: '',
        hasAvatar: true,
    };
    public render() {
        const {isAdmin, name, email, hasAvatar} = this.state;
        const users = this.props.users || [];
        return <>
            <h1>Log in</h1>
            <p>
                <label>
                    <input type='checkbox' checked={isAdmin} onClick={this.toggleAdmin} />
                    Log in as an admin
                </label>
            </p>
            <h4>Sign up as a new user</h4>
            <form onSubmit={this.signUp}>
                <div><label>Email</label></div>
                <div>
                    <input
                        type='email'
                        placeholder='Type an unique email address'
                        value={email}
                        onChange={this.onEmailChange}
                    />
                </div>
                <div><label>Name</label></div>
                <div>
                    <input
                        type='text'
                        placeholder='Type the full name'
                        value={name}
                        onChange={this.onNameChange}
                    />
                </div>
                <div>
                    <label>
                        <input
                            type='checkbox'
                            checked={hasAvatar}
                            onChange={this.onHasAvatarChange}
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
            {users.map((user) => (
                <button key={user.id} onClick={() => this.signInAs(user)}>
                {user.name}
                ({user.email})
                </button>
            ))}
        </>;
    }

    private toggleAdmin = () => {
        this.setState({isAdmin: !this.state.isAdmin});
    }
    private onEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({email: event.target.value});
    }
    private onNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({name: event.target.value});
    }
    private onHasAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({hasAvatar: event.target.checked});
    }

    private signUp = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const {email, name, hasAvatar} = this.state;
        const avatarHash = randomize(32, '01234567890abcdef');
        const picture = hasAvatar ? `https://www.gravatar.com/avatar/${avatarHash}?d=wavatar` : null;
        const user = await this.props.createUser.post({email, name, picture});
        this.signInAs(user);
    }

    private signInAs(user: User) {
        const asAdmin = this.state.isAdmin;
        const accessTokenPayload = {
            sub: user.id,
            exp: +new Date() + 1000 * 60 * 60,
        };
        const idTokenPayload = {
            ...accessTokenPayload,
            'email': user.email,
            'name': user.name,
            'picture': user.picture,
            'cognito:groups': asAdmin ? ['Administrators'] : [],
        };
        // Create the JWT token
        const accessToken = sign(accessTokenPayload, 'LOCAL_SECRET');
        const idToken = sign(idTokenPayload, 'LOCAL_SECRET');
        window.location.href = `${query.redirect_uri}#access_token=${accessToken}&id_token=${idToken}&state=${query.state}`;
    }
}

const ConnectedSignin = inject(Signin);

render(
    <ClientProvider client={client}>
        <ConnectedSignin />
    </ClientProvider>,
    document.getElementById('root'),
);
