import { HttpHeaders, HttpMethod, HttpStatus } from './http';

const enum AjaxState {
    UNSENT = 0,
    OPENED = 1,
    HEADERS_RECEIVED = 2,
    LOADING = 3,
    DONE = 4,
}

export interface AjaxRequest {
    method: HttpMethod;
    url: string;
    payload?: any;
    headers?: HttpHeaders;
}

export interface AjaxResponse {
    request: AjaxRequest;
    statusCode: HttpStatus;
    data?: any;
}

interface AjaxTextResponse {
    request: AjaxRequest;
    statusCode: HttpStatus;
    body: string;
}

export async function ajax(request: AjaxRequest): Promise<AjaxResponse> {
    const textResponse = await requestText(request);
    const {statusCode, body} = textResponse;
    const response: AjaxResponse = {statusCode, request};
    if (body) {
        // Attempt to parse the response text as JSON object.
        try {
            response.data = JSON.parse(body);
        } catch (error) {
            throw new AjaxError(request, statusCode, undefined, error);
        }
    }
    if (200 <= statusCode && statusCode < 300) {
        return response;
    }
    throw new AjaxError(request, statusCode, response.data);
}

function requestText(request: AjaxRequest): Promise<AjaxTextResponse> {
    return new Promise<AjaxTextResponse>((resolve, reject) => {
        const {headers, payload, url, method} = request;
        const xhr = new XMLHttpRequest();
        function onReadyStateChange(this: XMLHttpRequest) {
            // tslint:disable-next-line:no-shadowed-variable
            if (xhr.readyState === AjaxState.DONE) {
                // Ajax request has completed
                let statusCode = xhr.status;
                // normalize IE9 bug (http://bugs.jquery.com/ticket/1450)
                if (statusCode === 1223) {
                    statusCode = 204;
                }
                const body = xhr.responseText;
                resolve({request, statusCode, body});
            }
        }
        function onError(this: XMLHttpRequestEventTarget, error: ErrorEvent) {
            reject(new AjaxError(request, 0, undefined, error));
        }
        xhr.open(method, url, true);
        // Set the request headers
        if (headers) {
            for (const headerName in headers) {
                if (headers.hasOwnProperty(headerName)) {
                    const headerValue = headers[headerName];
                    if (headerValue) {
                        xhr.setRequestHeader(headerName, headerValue);
                    }
                }
            }
        }
        xhr.onerror = onError;
        xhr.onreadystatechange = onReadyStateChange;
        if (payload == null) {
            xhr.send();
        } else {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(payload));
        }
    });
}

export class AjaxError extends Error {
    constructor(public readonly request: AjaxRequest, public readonly statusCode: HttpStatus | 0, public readonly data?: any, public readonly error?: Error | Event) {
        super();
    }
}
