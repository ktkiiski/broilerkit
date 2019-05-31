import { LambdaHttpHandler, lambdaMiddleware } from '../lambda';
import { middleware } from '../middleware';
import { ApiService } from '../server';

const serviceModule = require('_service');
const service = new ApiService(serviceModule.default);

const executeLambda = lambdaMiddleware(middleware(
    (req) => service.execute(req),
));

/**
 * Entry point for Lambda requests.
 */
export const request: LambdaHttpHandler = (lambdaRequest, _, callback) => {
    executeLambda(lambdaRequest).then(
        (result) => callback(null, result),
        (error) => callback(error),
    );
};

export default service;
