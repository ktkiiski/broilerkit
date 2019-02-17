import { LambdaHttpHandler, lambdaMiddleware } from '../lambda';
import { middleware } from '../middleware';
import { ApiService } from '../server';

const executeLambda = lambdaMiddleware(
    middleware(async (req) => {
        // This module is bound with Webpack bundler to the configured API service
        const serviceModule = require('_service');
        const service: ApiService = serviceModule.default;
        return await service.execute(req);
    }),
);

export const request: LambdaHttpHandler = (lambdaRequest, _, callback) => {
    executeLambda(lambdaRequest).then(
        (result) => callback(null, result),
        (error) => callback(error),
    );
};
