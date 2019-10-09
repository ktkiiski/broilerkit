import { HttpMethod, HttpRequest, HttpResponse } from './http';
import { Controller } from './server';
import { UrlPattern } from './url';

export const OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME = 'oauth2SignInCallback' as const;
export const OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME = 'oauth2SignOutCallback' as const;

const signinCallbackHtml = `<!DOCTYPE html>
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
        window.opener.postMessage('[oauth2]:signin:' + window.location.hash, window.location.origin);
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

    public async execute(request: HttpRequest): Promise<HttpResponse> {
        // tslint:disable-next-line:no-console
        console.log(`Sign in callback:`, request.path, request.queryParameters);
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
            },
            body: signinCallbackHtml,
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

    public async execute(request: HttpRequest): Promise<HttpResponse> {
        // tslint:disable-next-line:no-console
        console.log(`Sign out callback:`, request.path, request.queryParameters);
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html',
            },
            body: signoutCallbackHtml,
        };
    }
}
