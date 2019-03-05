import { createHash } from 'crypto';
import { encodeSafeJSON, escapeHtml } from './html';
import { acceptsContentType, ApiResponse, BadRequest, HttpRequest, HttpResponse, HttpStatus, isReadHttpMethod, isResponse, isWriteHttpMethod, normalizeHeaders, parsePayload } from './http';
import { countBytes, findAllMatches } from './utils/strings';

type Response = HttpResponse | ApiResponse<any>;

export function middleware<P extends any[]>(
    handler: (request: HttpRequest, ...params: P) => Promise<Response>,
): (request: HttpRequest, ...params: P) => Promise<HttpResponse> {
    return compatibilityMiddleware(
        preconditionMiddleware(
            finalizerMiddleware(
                apiMiddleware(
                    errorMiddleware(
                        payloadParserMiddleware(
                            queryMethodSupportMiddleware(handler),
                        ),
                    ),
                ),
            ),
        ),
    );
}

export function requestMiddleware<I, O>(handleRequest: (request: I) => Promise<O>) {
    return <P extends any[], R>(handler: (request: O, ...params: P) => Promise<R>) => (
        async (request: I, ...params: P) => {
            const newRequest = await handleRequest(request);
            return await handler(newRequest, ...params);
        }
    );
}

export function responseMiddleware<I, O, R>(handleResponse: (response: I, request: R) => Promise<O>) {
    return <P extends any[]>(handler: (request: R, ...params: P) => Promise<I>) => (
        async (request: R, ...params: P) => {
            const response = await handler(request, ...params);
            return await handleResponse(response, request);
        }
    );
}

// TODO: Type separately raw HTTP requests and parsed ones?
const payloadParserMiddleware = requestMiddleware(async (request: HttpRequest) => {
    return parsePayload(request);
});

const queryMethodSupportMiddleware = requestMiddleware(async (request: HttpRequest) => {
    const httpMethod = request.method;
    const {method, ...queryParameters} = request.queryParameters;
    if (!method) {
        return request;
    }
    // Allow changing the HTTP method with 'method' query string parameter
    if ((httpMethod === 'GET' && isReadHttpMethod(method)) || (httpMethod === 'POST' && isWriteHttpMethod(method))) {
        return {...request, method, queryParameters};
    }
    throw new BadRequest(`Cannot perform ${httpMethod} as ${method} request`);
});

const compatibilityMiddleware = requestMiddleware(async (request: HttpRequest) => {
    return {
        ...request,
        // Convert headers to capitalized format, e.g. `content-type` => `Content-Type`
        headers: normalizeHeaders(request.headers),
    };
});

const apiMiddleware = responseMiddleware(async (response: Response, request: HttpRequest): Promise<HttpResponse> => {
    if ('body' in response) {
        // Already a response with encoded body
        return response;
    }
    const {statusCode, headers, data} = response;
    // If requesting a HTML page, then render as a HTML page
    if (acceptsContentType(request, 'text/html')) {
        // TODO: Improved page!
        const statusCodeHtml = escapeHtml(String(statusCode));
        const jsonHtml = data && encodeSafeJSON(data, null, 4) || '';
        return {
            ...response,
            headers: {
                ...headers,
                'Content-Type': 'text/html; charset=utf-8',
            },
            body: `<div>${statusCodeHtml}</div><pre>${jsonHtml}</pre>`,
        };
    }
    // Convert to JSON
    return {
        ...response,
        body: data == null ? '' : JSON.stringify(data),
        headers: {
            ...headers,
            'Content-Type': 'application/json',
        },
    };
});

export function errorMiddleware<R, P extends any[]>(handler: (request: R, ...params: P) => Promise<Response>): (request: R, ...params: P) => Promise<Response> {
    async function catchError(request: R, ...params: P): Promise<Response> {
        try {
            return await handler(request, ...params);
        } catch (error) {
            // Determine if the error was a HTTP response
            if (isResponse(error)) {
                // This was an intentional HTTP error, so it should be considered
                // a successful execution of the lambda function.
                return error;
            }
            // This doesn't seem like a HTTP response -> Pass through for the internal server error
            throw error;
        }
    }
    return catchError;
}

const finalizerMiddleware = responseMiddleware(async (response: HttpResponse, request: HttpRequest) => {
    const {statusCode, body, headers} = response;
    const hash = createHash('md5').update(body).digest('hex');
    return {
        statusCode,
        body,
        headers: {
            // Add the CORS headers
            'Access-Control-Allow-Origin': request.siteOrigin,
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,X-Requested-With',
            'Access-Control-Allow-Credentials': 'true',
            // Calculate the length for the response body
            'Content-Length': String(countBytes(body)),
            // Return the ETag
            'ETag': `"${hash}"`,
            ...headers,
        },
    };
});

function preconditionMiddleware<P extends any[]>(handler: (request: HttpRequest, ...params: P) => Promise<HttpResponse>): (request: HttpRequest, ...params: P) => Promise<HttpResponse> {
    async function handlePrecondition(request: HttpRequest, ...params: P): Promise<HttpResponse> {
        const {method} = request;
        const response = await handler(request, ...params);
        if (method !== 'GET' && method !== 'HEAD') {
            return response;
        }
        const etag = response.headers.ETag;
        const ifNoneMatch = request.headers['If-None-Match'];
        if (response.statusCode !== HttpStatus.OK || !etag || !ifNoneMatch) {
            return response;
        }
        const requiredTags = findAllMatches(ifNoneMatch, /"[^"]*"/g);
        if (requiredTags.indexOf(etag) < 0) {
            return response;
        }
        // Respond with 304 and without the body
        return {
            ...response,
            statusCode: HttpStatus.NotModified,
            body: '',
        };
    }
    return handlePrecondition;
}
