import { sign } from 'jsonwebtoken';
import { parseQuery } from '../url';

const query = parseQuery(window.location.search || '');
const element = document.getElementById('login-button');
if (element) {
    element.addEventListener('click', () => {
        const accessTokenPayload = {
            sub: '935d5915-4230-4618-a3c5-47344d8cd2c6',
            exp: +new Date() + 1000 * 60 * 60,
        };
        const idTokenPayload = {
            ...accessTokenPayload,
            email: 'john.smith@example.com',
            name: 'John Smith',
        };
        // Create the JWT token
        const accessToken = sign(accessTokenPayload, 'LOCAL_SECRET');
        const idToken = sign(idTokenPayload, 'LOCAL_SECRET');
        window.location.href = `${query.redirect_uri}#access_token=${accessToken}&id_token=${idToken}&state=${query.state}`;
    });
}
