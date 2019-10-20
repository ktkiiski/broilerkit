import base64url from 'base64url';
import * as jwt from 'jsonwebtoken';
import { BadRequest, HttpMethod, HttpRequest, HttpResponse } from './http';
import { tmpl } from './interpolation';
import { request } from './request';
import { Controller, ServerContext } from './server';
import { encryptSession, UserSession } from './sessions';
import { buildQuery, parseQuery, UrlPattern } from './url';
import { uuid4 } from './uuid';

export const OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME = 'oauth2SignInCallback' as const;
export const OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME = 'oauth2SignOutCallback' as const;

const renderSigninCallbackHtml = tmpl `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta content="ie-edge" http-equiv="x-ua-compatible">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<meta http-equiv="Content-type" content="text/html; charset=utf-8">
<title>Signed in successfully</title>
</head>
<body>
<script>
if (window.opener != null) {
    if (!window.opener.closed) {
        window.opener.postMessage('[oauth2]:signin:${'encodedAuthResult'}', window.location.origin);
    }
    setTimeout(function() { window.close(); }, 500);
}
</script>
</body>
</html>
`;

export class OAuth2SignInController implements Controller {
    public readonly methods: HttpMethod[] = ['GET', 'POST'];
    public readonly pattern = new UrlPattern('/oauth2/signin');
    public readonly tables = [];
    public readonly requiresAuth = false;

    public async execute(req: HttpRequest, context: ServerContext): Promise<HttpResponse> {
        const { region, queryParameters, environment } = req;
        const { code, state } = queryParameters;
        if (!code) {
            throw new BadRequest(`Missing "code" URL parameter`);
        }
        if (!state) {
            throw new BadRequest(`Missing "state" URL parameter`);
        }
        let refreshToken: string;
        let accessToken: string;
        let idToken: string;
        if (region === 'local') {
            // Dummy local sign in
            // NOTE: This branch cannot be reached by production code,
            // and even if would, the generated tokens won't be usable.
            const tokens = parseQuery(code);
            accessToken = tokens.access_token;
            idToken = tokens.id_token;
            refreshToken = 'LOCAL_REFRESH_TOKEN'; // TODO: Local refresh token!
        } else {
            const clientId = environment.AuthClientId;
            const clientSecret = environment.AuthClientSecret;
            const signInRedirectUri = environment.AuthSignInRedirectUri;
            const tokenUrl = environment.AuthTokenUri;
            // Request tokens using the code
            // https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html
            const credentials = base64url.encode(`${clientId}:${clientSecret}`);
            try {
                const tokenResponse = await request({
                    method: 'POST',
                    url: tokenUrl,
                    headers: {
                        'Authorization': `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: buildQuery({
                        grant_type: 'authorization_code',
                        client_id: clientId,
                        redirect_uri: signInRedirectUri,
                        code,
                    }),
                });
                const tokens = JSON.parse(tokenResponse.body);
                accessToken = tokens.access_token;
                idToken = tokens.id_token;
                refreshToken = tokens.refresh_token;
            } catch (error) {
                // tslint:disable-next-line:no-console
                console.error('Failed to retrieve authentication tokens:', error);
                throw new BadRequest('Authentication failed due to invalid "code" URL parameter');
            }
        }
        // Parse user information from the ID token
        const idTokenPayload = jwt.decode(idToken);
        if (!idTokenPayload || typeof idTokenPayload !== 'object') {
            throw new Error('AWS token endpoint responded with invalid ID token');
        }
        const accesTokenPayload = jwt.decode(accessToken);
        if (!accesTokenPayload || typeof accesTokenPayload !== 'object') {
            throw new Error('AWS token endpoint responded with invalid access token');
        }
        const exp = Math.min(idTokenPayload.exp, accesTokenPayload.exp);
        const timestamp = Math.floor(new Date().getTime() / 1000);
        const expiresAt = new Date(exp * 1000);
        const maxAge = Math.max(exp - timestamp, 0);
        const userId: string = idTokenPayload.sub || accesTokenPayload.sub;
        const userSession: UserSession = {
            id: userId,
            name: idTokenPayload.name,
            email: idTokenPayload.email,
            picture: idTokenPayload.picture,
            groups: idTokenPayload['cognito:groups'] || [],
            expiresAt,
            authenticatedAt: new Date(),
            session: uuid4(),
            refreshToken,
        };
        const secretKey = context.sessionEncryptionKey;
        const sessionToken = await encryptSession(userSession, secretKey);
        let setCookieHeader = `session=${sessionToken}; Max-Age=${maxAge}; HttpOnly; Path=/`;
        if (region !== 'local') {
            setCookieHeader = `${setCookieHeader}; Secure`;
        }
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
                'Set-Cookie': setCookieHeader,
            },
            body: renderSigninCallbackHtml({
                encodedAuthResult: buildQuery({
                    state,
                    id_token: idToken,
                    access_token: accessToken,
                }),
            }),
        };
    }
}

const signoutCallbackHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta content="ie-edge" http-equiv="x-ua-compatible">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<meta http-equiv="Content-type" content="text/html; charset=utf-8">
<title>Signed out successfully</title>
</head>
<body>
<script>
if (window.opener != null) {
    if (!window.opener.closed) {
        window.opener.postMessage('[oauth2]:signout', window.location.origin);
    }
    setTimeout(function() { window.close(); }, 500);
}
</script>
</body>
</html>
`;

export class OAuth2SignOutController implements Controller {
    public readonly methods: HttpMethod[] = ['GET', 'POST'];
    public readonly pattern = new UrlPattern('/oauth2/signout');
    public readonly tables = [];
    public readonly requiresAuth = false;

    public async execute(req: HttpRequest): Promise<HttpResponse> {
        const { region } = req;
        let setCookieHeader = `session=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
        if (region !== 'local') {
            setCookieHeader = `${setCookieHeader}; Secure`;
        }
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
                'Set-Cookie': setCookieHeader,
            },
            body: signoutCallbackHtml,
        };
    }
}
