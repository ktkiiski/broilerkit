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
import { OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME, OAuth2SignInController } from '../oauth';
import { OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME, OAuth2SignOutController } from '../oauth';
import { ApiService, ServerContext } from '../server';
import { RENDER_WEBSITE_ENDPOINT_NAME, SsrController } from '../ssr';

// When deployed, load the HTML base file immediately, which is expected to be located as a sibling index.html file
const pageHtml$ = readFile('./index.html');
// API service
const apiService = getApiService();
// Load the module exporting the rendered React component
const view: React.ComponentType<{}> = require('_site').default;
const service = apiService.extend({
    [RENDER_WEBSITE_ENDPOINT_NAME]: new SsrController(apiService, view, pageHtml$),
    [OAUTH2_SIGNIN_CALLBACK_ENDPOINT_NAME]: new OAuth2SignInController(),
    [OAUTH2_SIGNOUT_CALLBACK_ENDPOINT_NAME]: new OAuth2SignOutController(),
});

const region = process.env.AWS_REGION;
const databaseBaseConfig = {
    host: process.env.DATABASE_HOST as string,
    port: parseInt(process.env.DATABASE_PORT as string, 10),
    database: process.env.DATABASE_NAME as string,
    idleTimeoutMillis: 60 * 1000,
};
const credentialsArn = process.env.DATABASE_CREDENTIALS_ARN as string;
const secretsManagerService = new SecretsManager({
    apiVersion: '2017-10-17',
    region,
    httpOptions: { timeout: 5 * 1000 },
    maxRetries: 3,
});
const dbConnectionPool$ = secretsManagerService.getSecretValue({ SecretId: credentialsArn })
    .promise()
    .then(({ SecretString: secret }) => {
        if (!secret) {
            throw new Error('Response does not contain a SecretString');
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
const secretArn = process.env.USER_SESSION_ENCRYPTION_KEY_SECRET_ARN as string;
const sessionEncryptionKey$ = secretsManagerService.getSecretValue({ SecretId: secretArn })
    .promise()
    .then(async ({ SecretString: secret }) => {
        if (!secret) {
            throw new Error('Response does not contain a SecretString');
        }
        const keyJson = JSON.parse(secret);
        return JWK.asKey(keyJson);
    });

const serverContext$ = Promise
    .all([dbConnectionPool$, sessionEncryptionKey$])
    .then(([dbConnectionPool, sessionEncryptionKey]): ServerContext => {
        return { dbConnectionPool, sessionEncryptionKey };
    });

const executeLambda = lambdaMiddleware(middleware(async (req) => {
    const context = await serverContext$;
    return service.execute(req, context);
}));

/**
 * AWS Lambda compatible handler function that processes the given
 * requests by performing the server-side rendering of the view, and
 * calling the callback with a HTML page response.
 *
 * The view is imported with `require('_site')`, which will be aliased
 * with the bundler. Therefore, this function can only be called from
 * the actual bundled script.
 */
export const request: LambdaHttpHandler = async (lambdaRequest) => (
    executeLambda(lambdaRequest)
);

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
