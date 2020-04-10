import base64url from 'base64url';
import * as jwt from 'jsonwebtoken';
import { ApiResponse, BadRequest, HttpMethod, HttpRequest, HttpResponse, HttpStatus, NotImplemented, parseCookies } from './http';
import { request } from './request';
import { Controller, ServerContext } from './server';
import { decryptSession, encryptSession, UserSession } from './sessions';
import { decryptToken, encryptToken } from './tokens';
import { buildQuery, parseQuery, parseUrl, Url, UrlPattern } from './url';
import { uuid4 } from './uuid';

export const OAUTH2_SIGNIN_ENDPOINT_NAME = 'oauth2SignIn' as const;
export const OAUTH2_SIGNOUT_ENDPOINT_NAME = 'oauth2SignOut' as const;
export const OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME = 'oauth2SignInCallback' as const;
export const OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME = 'oauth2SignOutCallback' as const;

const signInTimeout = 60 * 60;
const signOutTimeout = 60 * 10;
const sessionDuration = 60 * 60 * 3; // TODO: Make configurable!

/**
 * Starts login flow. User should be redirected to this URL
 * after clicking a "Log in" link.
 *
 * /oauth2/sign_in
 * /oauth2/sign_in?redirect_uri=/mypage
 * /oauth2/sign_in?identity_provider=Facebook&redirect_uri=/mypage
 */
export class OAuth2SignInController implements Controller {
    public readonly methods: HttpMethod[] = ['GET', 'POST'];
    public readonly pattern = new UrlPattern('/oauth2/sign_in');
    public readonly tables = [];

    public async execute(req: HttpRequest, context: ServerContext): Promise<HttpResponse> {
        const { sessionEncryptionKey } = context;
        if (!sessionEncryptionKey) {
            throw new NotImplemented(`Authentication is not enabled`);
        }
        const { region, serverOrigin, queryParameters } = req;
        const identityProvider = queryParameters.identity_provider;
        const finalRedirectUri = queryParameters.redirect_uri || '/';
        const clientId = context.authClientId as string;
        const signInUri = context.authSignInUri as string;
        const callbackUri = `${serverOrigin}/oauth2/signed_in`;
        if (!signInUri) {
            throw new NotImplemented(`Authentication sign in URI not configured`);
        }
        if (!finalRedirectUri.startsWith('/') && !finalRedirectUri.startsWith(serverOrigin)) {
            throw new BadRequest(`Invalid redirect URI`);
        }
        const timestamp = new Date().getTime() / 1000;
        const statePayload = {
            jti: uuid4(),
            sid: uuid4(),
            exp: timestamp + signInTimeout,
            aud: callbackUri,
            redirect_uri: finalRedirectUri,
            identity_provider: identityProvider || null,
        };
        const state = await encryptToken(statePayload, sessionEncryptionKey);
        const redirectUriParams: Record<string, string> = {
            state,
            redirect_uri: callbackUri,
            client_id: clientId,
            response_type: 'code',
        };
        if (identityProvider) {
            redirectUriParams.identity_provider = identityProvider;
        }
        const redirectUri = parseUrl(signInUri).withParameters(redirectUriParams);
        const signInCookieHeader = getSetCookieHeader('signin', state, signInTimeout, region, '/oauth2');
        return redirect(redirectUri.toString(), [signInCookieHeader]);
    }
}

export class OAuth2SignedInController implements Controller {
    public readonly methods: HttpMethod[] = ['GET', 'POST'];
    public readonly pattern = new UrlPattern('/oauth2/signed_in');
    public readonly tables = [];

    public async execute(req: HttpRequest, context: ServerContext): Promise<HttpResponse> {
        const { sessionEncryptionKey } = context;
        if (!sessionEncryptionKey) {
            throw new NotImplemented(`Authentication is not enabled`);
        }
        const { region, queryParameters, headers } = req;
        const { code, state, error, error_description } = queryParameters;
        const callbackUri = `${req.serverOrigin}/oauth2/signed_in`;
        const cookies = parseCookies(headers.Cookie || '');
        if (!state) {
            throw new BadRequest(`Missing "state" URL parameter`);
        }
        const timestamp = new Date().getTime() / 1000;
        let statePayload: any;
        try {
            statePayload = await decryptToken(state, sessionEncryptionKey.keystore);
        } catch (error) {
            // tslint:disable-next-line:no-console
            console.error(`Invalid "state" returned from the authentication provider:`, error);
            throw new BadRequest(`Invalid "state" URL parameter`);
        }
        if (statePayload.aud !== callbackUri) {
            throw new BadRequest(`Invalid authentication request`);
        }
        const identityProvider = statePayload.identity_provider;
        const redirectUri = statePayload.redirect_uri;
        const sessionId = statePayload.sid;
        if (!sessionId) {
            throw new BadRequest('Missing session ID');
        }
        if (statePayload.exp <= timestamp || state !== cookies.signin) {
            // Authentication has expired. Try again!
            let retryUrl = new Url('/oauth2/sign_in', { redirect_uri: redirectUri });
            if (identityProvider) {
                retryUrl = retryUrl.withParameters({ identity_provider: identityProvider });
            }
            const setCookieHeader = getSetCookieHeader('signin', '', null, region, '/oauth2');
            return redirect(retryUrl.toString(), [setCookieHeader]);
        }
        if (error) {
            const linkErrorMatch =  /^already found an entry for username (Google|Facebook)_\w+/i.exec(error_description || '');
            if (linkErrorMatch) {
                // The failure is due to a bug/fuckup in AWS Cognito,
                // when linking a signup user to an existing user. See:
                // https://forums.aws.amazon.com/thread.jspa?threadID=267154
                // To work around this, we re-authenticate with the user with the chosen provider.
                const providerName = linkErrorMatch[1];
                const retryUri = new Url('/oauth2/sign_in', {
                    identity_provider: providerName,
                    redirect_uri: redirectUri,
                });
                const setCookieHeader = getSetCookieHeader('signin', '', null, region, '/oauth2');
                return redirect(retryUri.toString(), [setCookieHeader]);
            }
            // Other kind of authentication error
            const errorRedirectUri = parseUrl(redirectUri).withParameters({ error, error_description });
            return redirect(errorRedirectUri.toString());
        }
        if (!code) {
            throw new BadRequest(`Missing "code" URL parameter`);
        }
        let tokens: TokenResponse;
        if (region === 'local') {
            // Dummy local sign in
            // NOTE: This branch cannot be reached by production code,
            // and even if would, the generated tokens won't be usable.
            const parsedCode = parseQuery(code);
            tokens = {
                id_token: parsedCode.id_token,
                refresh_token: 'LOCAL_REFRESH_TOKEN', // TODO: Local refresh token!
                expires_in: 60 * 10,
            };
        } else {
            const clientId = context.authClientId as string;
            const clientSecret = context.authClientSecret as string;
            const tokenUrl = context.authTokenUri as string;
            // Request tokens using the code
            try {
                tokens = await requestTokens(tokenUrl, clientId, clientSecret, {
                    grant_type: 'authorization_code',
                    client_id: clientId,
                    redirect_uri: callbackUri,
                    code,
                });
            } catch (error) {
                // tslint:disable-next-line:no-console
                console.error('Failed to retrieve authentication tokens:', error);
                throw new BadRequest('Authentication failed due to invalid "code" URL parameter');
            }
        }
        // Parse user information from the ID token
        const userSession = parseUserSession(tokens, sessionId, sessionDuration);
        const sessionToken = await encryptSession(userSession, sessionEncryptionKey);
        const signInCookieHeader = getSetCookieHeader('signin', '', null, region, '/oauth2');
        const sessionCookieHeader = getSetCookieHeader('session', sessionToken, sessionDuration, region);
        return redirect(redirectUri, [sessionCookieHeader, signInCookieHeader]);
    }
}

/**
 * Starts logout flow. User should be redirected to this URL
 * after clicking a "Log out" link.
 *
 * /oauth2/sign_out
 * /oauth2/sign_out?redirect_uri=/mypage
 */
export class OAuth2SignOutController implements Controller {
    public readonly methods: HttpMethod[] = ['GET', 'POST'];
    public readonly pattern = new UrlPattern('/oauth2/sign_out');
    public readonly tables = [];

    public async execute(req: HttpRequest, context: ServerContext): Promise<HttpResponse> {
        const { sessionEncryptionKey } = context;
        if (!sessionEncryptionKey) {
            throw new NotImplemented(`Authentication is not enabled`);
        }
        const { region, queryParameters } = req;
        const clientId = context.authClientId as string;
        const finalRedirectUri = queryParameters.redirect_uri || '/';
        const signOutUri = context.authSignOutUri as string;
        const callbackUri = `${req.serverOrigin}/oauth2/signed_out`;
        if (!signOutUri) {
            throw new NotImplemented(`Authentication sign out URI not configured`);
        }
        const statePayload = {
            jti: uuid4(),
            aud: callbackUri,
            redirect_uri: finalRedirectUri,
        };
        const state = await encryptToken(statePayload, sessionEncryptionKey);
        const redirectUri = parseUrl(signOutUri).withParameters({
            state,
            logout_uri: callbackUri,
            client_id: clientId,
        });
        const signOutCookieHeader = getSetCookieHeader('signout', state, signOutTimeout, region, '/oauth2');
        const sessionCookieHeader = getSetCookieHeader('session', '', null, region);
        return redirect(redirectUri.toString(), [sessionCookieHeader, signOutCookieHeader]);
    }
}

export class OAuth2SignedOutController implements Controller {
    public readonly methods: HttpMethod[] = ['GET', 'POST'];
    public readonly pattern = new UrlPattern('/oauth2/signed_out');
    public readonly tables = [];

    public async execute(req: HttpRequest, context: ServerContext): Promise<HttpResponse> {
        const { region, headers } = req;
        const { sessionEncryptionKey } = context;
        if (!sessionEncryptionKey) {
            throw new NotImplemented(`Authentication is not enabled`);
        }
        const cookies = parseCookies(headers.Cookie || '');
        const state = cookies.signout;
        let redirectUri = '/';
        if (state) {
            try {
                const statePayload = await decryptToken(state, sessionEncryptionKey.keystore);
                const requiredAud = `${req.serverOrigin}/oauth2/signed_out`;
                if (statePayload.aud === requiredAud && statePayload.redirect_uri) {
                    redirectUri = statePayload.redirect_uri;
                }
            } catch (error) {
                // tslint:disable-next-line:no-console
                console.error(`Invalid state cookie when signing out`, error);
            }
        }
        const signOutCookieHeader = getSetCookieHeader('signout', '', null, region, '/oauth2');
        const setCookieHeader = getSetCookieHeader('session', '', null, region);
        return redirect(redirectUri, [setCookieHeader, signOutCookieHeader]);
    }
}

export function authenticationMiddleware<P extends any[], R extends HttpResponse | ApiResponse>(handler: (request: HttpRequest, context: ServerContext, ...params: P) => Promise<R>) {
    async function handleAuthentication(req: HttpRequest, context: ServerContext, ...params: P): Promise<R> {
        const { sessionEncryptionKey } = context;
        const { region, headers } = req;
        if (!sessionEncryptionKey) {
            throw new NotImplemented(`Authentication is not enabled`);
        }
        const keyStore = sessionEncryptionKey.keystore;
        const cookies = parseCookies(headers.Cookie || '');
        const sessionToken = cookies.session;
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
                // Request tokens using the code
                const clientId = context.authClientId as string;
                const clientSecret = context.authClientSecret as string;
                const tokenUrl = context.authTokenUri as string;
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
        let setCookieHeader: string;
        if (session) {
            const token = await encryptSession(session, sessionEncryptionKey);
            setCookieHeader = getSetCookieHeader('session', token, sessionDuration, region);
        } else {
            setCookieHeader = getSetCookieHeader('session', '', null, region);
        }
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
        name: idTokenPayload.name || null,
        email: idTokenPayload.email || null,
        picture: idTokenPayload.picture || null,
        groups: idTokenPayload['cognito:groups'] || [],
        expiresAt,
        authenticatedAt: now,
        session: sessionId,
        refreshToken: tokens.refresh_token,
        refreshedAt: now,
        refreshAfter,
    };
}

function getSetCookieHeader(cookie: string, value: string, maxAge: number | null, region: string, path = '/'): string {
    let setCookieHeader = maxAge == null
        ? `${cookie}=; Path=${path}; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
        : `${cookie}=${value}; Path=${path}; HttpOnly; Max-Age=${maxAge}`;
    if (region !== 'local') {
        setCookieHeader = `${setCookieHeader}; Secure`;
    }
    return setCookieHeader;
}

function redirect(redirectUri: string, setCookies?: string[]): HttpResponse {
    return {
        statusCode: HttpStatus.Found,
        headers: {
            Location: redirectUri,
            ...setCookies ? { 'Set-Cookie': setCookies } : null,
        },
        body: '',
    };
}
