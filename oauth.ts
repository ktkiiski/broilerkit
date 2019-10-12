import base64url from 'base64url';
import { BadRequest, HttpMethod, HttpRequest, HttpResponse } from './http';
import { tmpl } from './interpolation';
import { request } from './request';
import { Controller } from './server';
import { buildQuery, parseQuery, UrlPattern } from './url';

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

    public async execute(req: HttpRequest): Promise<HttpResponse> {
        const { region, queryParameters, environment } = req;
        const { code, state } = queryParameters;
        if (!code) {
            throw new BadRequest(`Missing "code" URL parameter`);
        }
        if (!state) {
            throw new BadRequest(`Missing "state" URL parameter`);
        }
        const authResult: Record<string, string> = { state };
        if (region === 'local') {
            // Dummy local sign in
            // NOTE: This branch cannot be reached by production code,
            // and even if would, the generated tokens won't be usable.
            const tokens = parseQuery(code);
            authResult.access_token = tokens.access_token;
            authResult.id_token = tokens.id_token;
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
                authResult.access_token = tokens.access_token;
                authResult.id_token = tokens.id_token;
            } catch (error) {
                // tslint:disable-next-line:no-console
                console.error('Failed to retrieve authentication tokens:', error);
                throw new BadRequest('Authentication failed due to invalid "code" URL parameter');
            }
        }
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
            },
            body: renderSigninCallbackHtml({
                encodedAuthResult: buildQuery(authResult),
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
        // tslint:disable-next-line:no-console
        console.log(`Sign out callback:`, req.path, req.queryParameters);
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
            },
            body: signoutCallbackHtml,
        };
    }
}
