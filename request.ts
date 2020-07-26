/* eslint-disable @typescript-eslint/no-explicit-any */
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { readStream } from './fs';
import { HttpMethod, normalizeHeaders } from './http';
import { forEachKey } from './objects';

interface Request extends https.RequestOptions {
    url: string;
    query?: { [param: string]: string };
    method: HttpMethod;
    body?: string;
}

interface JsonRequest extends https.RequestOptions {
    url: string;
    query?: { [param: string]: string };
    method: HttpMethod;
    data?: any;
}

interface Response {
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

interface JsonResponse extends Response {
    data: any;
}

export async function request({ url, query, body: requestBody, ...options }: Request): Promise<Response> {
    const urlObj = new URL(url);
    if (query) {
        forEachKey(query, (key, value) => {
            urlObj.searchParams.set(key, value);
        });
    }
    const httpLib = urlObj.protocol === 'https:' || urlObj.port === '443' ? https : http;
    const resp = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const requestOptions = {
            protocol: urlObj.protocol,
            host: urlObj.host,
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            hash: urlObj.hash,
            ...options,
        };
        const clientRequest = httpLib.request(requestOptions, resolve);
        clientRequest.on('error', reject);
        if (requestBody != null) {
            clientRequest.write(requestBody);
        }
        clientRequest.end();
    });
    const chunks = await readStream(resp);
    const body = chunks.join('');
    const { statusCode, headers: rawHeaders } = resp;
    if (statusCode == null) {
        throw new Error(`Responded with invalid status code`);
    }
    const headers = normalizeHeaders(rawHeaders);
    if (statusCode >= 200 && statusCode < 300) {
        return { statusCode, headers, body };
    }
    throw Object.assign(new Error('Request failed'), { statusCode, headers, body });
}

export async function requestJson({ data, ...options }: JsonRequest): Promise<JsonResponse> {
    const response = await request({
        ...options,
        body: data == null ? undefined : JSON.stringify(data),
    });
    return {
        ...response,
        data: response.body ? JSON.parse(response.body) : null,
    };
}
