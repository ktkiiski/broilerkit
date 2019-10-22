import base64url from 'base64url';
import * as jwt from 'jsonwebtoken';
import { ApiResponse, BadRequest, HttpMethod, HttpRequest, HttpResponse } from './http';
import { tmpl } from './interpolation';
import { request } from './request';
import { Controller, ServerContext } from './server';
import { decryptSession, encryptSession, UserSession } from './sessions';
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

const sessionDuration = 60 * 60 * 3; // TODO: Make configurable!

export class OAuth2SignInController implements Controller {
    public readonly methods: HttpMethod[] = ['GET', 'POST'];
    public readonly pattern = new UrlPattern('/oauth2/signin');
    public readonly tables = [];

    public async execute(req: HttpRequest, context: ServerContext): Promise<HttpResponse> {
        const { region, queryParameters, environment } = req;
        const { code, state } = queryParameters;
        if (!code) {
            throw new BadRequest(`Missing "code" URL parameter`);
        }
        if (!state) {
            throw new BadRequest(`Missing "state" URL parameter`);
        }
        let tokens: TokenResponse;
        if (region === 'local') {
            // Dummy local sign in
            // NOTE: This branch cannot be reached by production code,
            // and even if would, the generated tokens won't be usable.
            const parsedCode = parseQuery(code);
            tokens = {
                id_token: parsedCode.id_token,
                access_token: parsedCode.access_token,
                refresh_token: 'LOCAL_REFRESH_TOKEN', // TODO: Local refresh token!
                expires_in: 60 * 10,
            };
        } else {
            const clientId = environment.AuthClientId;
            const clientSecret = environment.AuthClientSecret;
            const signInRedirectUri = environment.AuthSignInRedirectUri;
            const tokenUrl = environment.AuthTokenUri;
            // Request tokens using the code
            try {
                tokens = await requestTokens(tokenUrl, clientId, clientSecret, {
                    grant_type: 'authorization_code',
                    client_id: clientId,
                    redirect_uri: signInRedirectUri,
                    code,
                });
            } catch (error) {
                // tslint:disable-next-line:no-console
                console.error('Failed to retrieve authentication tokens:', error);
                throw new BadRequest('Authentication failed due to invalid "code" URL parameter');
            }
        }
        // Parse user information from the ID token
        const userSession = parseUserSession(tokens, uuid4(), sessionDuration);
        const secretKey = context.sessionEncryptionKey;
        const sessionToken = await encryptSession(userSession, secretKey);
        const setCookieHeader = getSetSessionCookieHeader(sessionToken, sessionDuration, region);
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
                'Set-Cookie': setCookieHeader,
            },
            body: renderSigninCallbackHtml({
                encodedAuthResult: buildQuery({
                    state,
                    id_token: tokens.id_token,
                    access_token: tokens.access_token,
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

    public async execute(req: HttpRequest): Promise<HttpResponse> {
        const { region } = req;
        const setCookieHeader = getSetSessionCookieHeader('', null, region);
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

export function authenticationMiddleware<P extends any[], R extends HttpResponse | ApiResponse>(handler: (request: HttpRequest, context: ServerContext, ...params: P) => Promise<R>) {
    async function handleAuthentication(req: HttpRequest, context: ServerContext, ...params: P): Promise<R> {
        const { region, headers, environment } = req;
        const { sessionEncryptionKey } = context;
        const keyStore = sessionEncryptionKey.keystore;
        const cookieHeader = headers.Cookie;
        const sessionTokenMatch = cookieHeader && /(?:^|;\s*)session=([^;]+)(?:$|;)/.exec(cookieHeader);
        const sessionToken = sessionTokenMatch && sessionTokenMatch[1];
        let cookieSession: UserSession | null = null;
        if (sessionToken) {
            try {
                cookieSession = await decryptSession(sessionToken, keyStore);
            } catch (error) {
                // Invalid session token
                // tslint:disable-next-line:no-console
                console.warn(`Invalid session token: ${sessionToken}`, error);
            }
        }
        let session: UserSession | null = cookieSession;
        // Ensure that session has not yet expired
        const now = new Date();
        if (session && session.expiresAt <= now) {
            // Session has expired. Delete the session token
            session = null;
        }
        if (session && session.refreshAfter < now) {
            if (region === 'local') {
                // Dummy local renewal
                // NOTE: This branch cannot be reached by production code,
                // and even if would, the generated tokens won't be usable.
                session = {
                    ...session,
                    refreshedAt: now,
                    refreshAfter: new Date(+now + 1000 * 60 * 10),
                };
            } else {
                const clientId = environment.AuthClientId;
                const clientSecret = environment.AuthClientSecret;
                const tokenUrl = environment.AuthTokenUri;
                // Request tokens using the code
                try {
                    const tokens = await requestTokens(tokenUrl, clientId, clientSecret, {
                        grant_type: 'refresh_token',
                        client_id: clientId,
                        refresh_token: session.refreshToken,
                    });
                    tokens.refresh_token = session.refreshToken;
                    session = parseUserSession(tokens, session.session, sessionDuration);
                } catch (error) {
                    // tslint:disable-next-line:no-console
                    console.error('Failed to renew authentication tokens:', error);
                    // Could not renew the information, so assume not authenticated!
                    session = null;
                }
            }
        }
        const authRequest: HttpRequest = { ...req, auth: session };
        const response = await handler(authRequest, context, ...params);
        if (session === cookieSession) {
            // No change in the session
            return response;
        }
        // Set a new cookie if the session has changed
        // TODO: The Max-Age should be the actual remaining session duration!
        const setCookieHeader = session
            ? getSetSessionCookieHeader(await encryptSession(session, sessionEncryptionKey), sessionDuration, region)
            : getSetSessionCookieHeader('', null, region);
        return {
            ...response,
            headers: {
                ...response.headers,
                'Set-Cookie': setCookieHeader,
            },
        };
    }
    return handleAuthentication;
}

interface TokenResponse {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

async function requestTokens(tokenUrl: string, clientId: string, clientSecret: string, query: {[key: string]: string}): Promise<TokenResponse> {
    // https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html
    const credentials = base64url.encode(`${clientId}:${clientSecret}`);
    const tokenResponse = await request({
        method: 'POST',
        url: tokenUrl,
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: buildQuery(query),
    });
    return JSON.parse(tokenResponse.body);
}

function parseUserSession(tokens: TokenResponse, sessionId: string, expiresIn: number): UserSession {
    const idTokenPayload = jwt.decode(tokens.id_token);
    if (!idTokenPayload || typeof idTokenPayload !== 'object') {
        throw new Error('AWS token endpoint responded with invalid ID token');
    }
    const now = new Date();
    const expiresAt = new Date(+now + expiresIn * 1000);
    const refreshAfter = new Date(+now + tokens.expires_in * 1000 / 2);
    const userId: string = idTokenPayload.sub;
    return {
        id: userId,
        name: idTokenPayload.name,
        email: idTokenPayload.email,
        picture: idTokenPayload.picture,
        groups: idTokenPayload['cognito:groups'] || [],
        expiresAt,
        authenticatedAt: now,
        session: sessionId,
        refreshToken: tokens.refresh_token,
        refreshedAt: now,
        refreshAfter,
    };
}

function getSetSessionCookieHeader(token: string, maxAge: number | null, region: string): string {
    let setCookieHeader = maxAge == null
        ? `session=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
        : `session=${token}; Max-Age=${maxAge}; HttpOnly; Path=/`;
    if (region !== 'local') {
        setCookieHeader = `${setCookieHeader}; Secure`;
    }
    return setCookieHeader;
}
