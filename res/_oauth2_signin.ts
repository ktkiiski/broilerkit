import { sign } from 'jsonwebtoken';
import { initApi } from '../api';
import * as api from '../auth-local-api';
import { Client } from '../client';
import { parseQuery } from '../url';
import { User } from '../users';
import { randomize } from '../utils/strings';

declare const __API_ROOT__: string;

const query = parseQuery(window.location.search || '');
const client = new Client(__API_ROOT__);

async function signIn() {
    const {_usersCollection} = initApi(api, client);
    const users = await _usersCollection.getAll({ordering: 'name', direction: 'asc'});
    for (const user of users) {
        const element = document.createElement('button');
        element.innerText = `${user.name} (${user.email})`;
        element.addEventListener('click', (event) => {
            event.preventDefault();
            signInAs(user);
        });
        window.document.body.appendChild(element);
    }
}

async function signUp() {
    const {_usersCollection} = initApi(api, client);
    const formElement = document.getElementById('registration-form') as HTMLFormElement;
    const emailInputElement = document.getElementById('email-input') as HTMLInputElement;
    const nameInputElement = document.getElementById('name-input') as HTMLInputElement;
    const avatarCheckboxElement = document.getElementById('avatar-checkbox') as HTMLInputElement;
    formElement.addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = emailInputElement.value;
        const name = nameInputElement.value;
        const hasAvatar = avatarCheckboxElement.checked;
        const avatarHash = randomize(32, '01234567890abcdef');
        const user = await _usersCollection.post({
            email, name,
            picture: hasAvatar ? `https://www.gravatar.com/avatar/${avatarHash}?d=wavatar` : null,
        });
        signInAs(user);
    });
}

function signInAs(user: User) {
    const adminCheckboxElement = document.getElementById('login-as-admin-checkbox') as HTMLInputElement;
    const asAdmin = adminCheckboxElement.checked;
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

signIn();
signUp();
