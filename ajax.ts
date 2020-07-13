/* eslint-disable @typescript-eslint/no-explicit-any */
import { ApiResponse, HttpMethod, HttpRequestHeaders, HttpResponse, HttpResponseHeaders, HttpStatus, parseHeaders } from './http';
import hasOwnProperty from 'immuton/hasOwnProperty';

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
    headers?: HttpRequestHeaders;
}

export async function ajaxJson(request: AjaxRequest): Promise<ApiResponse> {
    const textResponse = await requestRaw(request);
    const {statusCode, body, headers} = textResponse;
    let response;
    if (body) {
        // Attempt to parse the response text as JSON object.
        try {
            response = {statusCode, headers, data: JSON.parse(body)};
        } catch (error) {
            throw new AjaxError(request, statusCode, {}, body, undefined, error);
        }
    } else {
        response = {statusCode, headers};
    }
    if (200 <= statusCode && statusCode < 300) {
        return response;
    }
    throw new AjaxError(request, statusCode, headers, response.data, body);
}

export async function ajax(request: AjaxRequest): Promise<HttpResponse> {
    const response = await requestRaw(request);
    const { statusCode } = response;
    if (200 <= statusCode && statusCode < 300) {
        return response;
    }
    throw new AjaxError(request, statusCode, response.headers, response.body);
}

function requestRaw(request: AjaxRequest): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
        const {headers, payload, url, method} = request;
        const xhr = new XMLHttpRequest();
        function onReadyStateChange(this: XMLHttpRequest) {            if (xhr.readyState === AjaxState.DONE) {
                // Ajax request has completed
                let statusCode = xhr.status;
                // normalize IE9 bug (http://bugs.jquery.com/ticket/1450)
                if (statusCode === 1223) {
                    statusCode = 204;
                }
                resolve({
                    statusCode,
                    body: getBody(xhr),
                    headers: parseHeaders(xhr.getAllResponseHeaders()),
                });
            }
        }
        function onError(this: XMLHttpRequestEventTarget, error: ProgressEvent) {
            reject(new AjaxError(request, 0, {}, getBody(xhr), undefined, error));
        }
        xhr.open(method, url, true);
        // Set the request headers
        if (headers) {
            for (const headerName in headers) {
                if (hasOwnProperty(headers, headerName)) {
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
        } else if (payload instanceof FormData) {
            xhr.send(payload);
        } else {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(payload));
        }
    });
}

function getBody(xhr: XMLHttpRequest): string {
    try {
        return xhr.responseText;
    } catch {
        return '';
    }
}

export class AjaxError extends Error implements ApiResponse, HttpResponse {
    constructor(
        public readonly request: AjaxRequest,
        public readonly statusCode: HttpStatus | 0,
        public readonly headers: HttpResponseHeaders,
        public readonly body: string,
        public readonly data: any = null,
        public readonly error?: Error | Event,
    ) {
        super();
    }
}
