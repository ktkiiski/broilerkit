/**
 * IMPORTANT: Do not import this file directly!
 * This is used as an endpoint file for a webpack bundle!
 */
import { SecretsManager } from 'aws-sdk';
import { JWK } from 'node-jose';
import { Pool } from 'pg';
import { readFile } from '../fs';
import { LambdaHttpHandler, lambdaMiddleware } from '../lambda';
import { middleware } from '../middleware';
import { authenticationMiddleware } from '../oauth';
import { OAUTH2_SIGNIN_ENDPOINT_NAME, OAuth2SignInController } from '../oauth';
import { OAUTH2_SIGNOUT_ENDPOINT_NAME, OAuth2SignOutController } from '../oauth';
import { OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME, OAuth2SignedInController } from '../oauth';
import { OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME, OAuth2SignedOutController } from '../oauth';
import { ApiService, ServerContext } from '../server';
import { RENDER_WEBSITE_ENDPOINT_NAME, SsrController } from '../ssr';

// When deployed, load the HTML base file immediately, which is expected to be located as a sibling index.html file
const pageHtml$ = readFile('./index.html');
// API service
const apiService = getApiService();
// Database
const db = getDatabase();
// Load the module exporting the rendered React component
const view: React.ComponentType<{}> = require('_site').default;
const service = apiService.extend({
    [RENDER_WEBSITE_ENDPOINT_NAME]: new SsrController(apiService, view, pageHtml$),
    [OAUTH2_SIGNIN_ENDPOINT_NAME]: new OAuth2SignInController(),
    [OAUTH2_SIGNOUT_ENDPOINT_NAME]: new OAuth2SignOutController(),
    [OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedInController(),
    [OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME]: new OAuth2SignedOutController(),
});

const region = process.env.AWS_REGION;
const databaseBaseConfig = {
    host: process.env.DATABASE_HOST as string,
    port: parseInt(process.env.DATABASE_PORT as string, 10),
    database: process.env.DATABASE_NAME as string,
    idleTimeoutMillis: 60 * 1000,
};
const secretsManagerService = new SecretsManager({
    apiVersion: '2017-10-17',
    region,
    httpOptions: { timeout: 5 * 1000 },
    maxRetries: 3,
});
const dbCredentialsSecretArn = process.env.DATABASE_CREDENTIALS_ARN;
const dbConnectionPool$ = retrieveSecret(dbCredentialsSecretArn).then((secret) => {
    if (secret == null) {
        return null;
    }
    const { username, password } = JSON.parse(secret);
    if (typeof username !== 'string' || !username) {
        throw new Error('Secrets manager credentials are missing "username"');
    }
    if (typeof password !== 'string' || !password) {
        throw new Error('Secrets manager credentials are missing "password"');
    }
    return new Pool({ ...databaseBaseConfig, user: username, password });
});
const encryptionSecretArn = process.env.USER_SESSION_ENCRYPTION_KEY_SECRET_ARN;
const sessionEncryptionKey$ = retrieveSecret(encryptionSecretArn).then(async (secret) => {
    if (secret == null) {
        return null;
    }
    const keyJson = JSON.parse(secret);
    return JWK.asKey(keyJson);
});

const serverContext$ = Promise
    .all([dbConnectionPool$, sessionEncryptionKey$])
    .then(([dbConnectionPool, sessionEncryptionKey]): ServerContext => {
        return { dbConnectionPool, sessionEncryptionKey, db };
    });

const executeService = middleware(authenticationMiddleware(service.execute));

/**
 * AWS Lambda compatible handler function that processes the given
 * requests by performing the server-side rendering of the view, and
 * calling the callback with a HTML page response.
 *
 * The view is imported with `require('_site')`, which will be aliased
 * with the bundler. Therefore, this function can only be called from
 * the actual bundled script.
 */
export const request: LambdaHttpHandler = lambdaMiddleware(async (req) => {
    const context = await serverContext$;
    return executeService(req, context);
});

function getApiService() {
    let apiModule;
    try {
        apiModule = require('_service');
    } catch {
        // No API available
        return new ApiService({});
    }
    return new ApiService(apiModule.default);
}

function getDatabase() {
    let dbModule;
    try {
        dbModule = require('_db');
    } catch {
        // No API available
        return null;
    }
    return dbModule.default;
}

async function retrieveSecret(secretArn: string | undefined) {
    if (!secretArn) {
        return null;
    }
    const secretRequest = secretsManagerService.getSecretValue({ SecretId: secretArn });
    const secretResponse = await secretRequest.promise();
    return secretResponse.SecretString;
}
