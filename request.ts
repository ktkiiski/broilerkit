import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { HttpMethod } from './http';
import { forEachKey } from './utils/objects';

interface Request extends https.RequestOptions {
    url: string;
    query?: {[param: string]: string};
    method: HttpMethod;
    body?: string;
}

interface JsonRequest extends https.RequestOptions {
    url: string;
    query?: {[param: string]: string};
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

export function request({url, query, body, ...options}: Request): Promise<Response> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        if (query) {
            forEachKey(query, (key, value) => {
                urlObj.searchParams.set(key, value);
            });
        }
        const clientRequest = https.request({
            protocol: urlObj.protocol,
            host: urlObj.host,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            hash: urlObj.hash,
            ...options,
        }, (resp) => {
            // tslint:disable-next-line:no-shadowed-variable
            let body = '';
            resp.on('data', (chunk) => { body += chunk; });
            resp.on('end', () => {
                const {statusCode, headers} = resp;
                if (statusCode && statusCode >= 200 && statusCode < 300) {
                    resolve({statusCode, headers, body});
                } else {
                    reject({statusCode, headers, body});
                }
            });
        });
        clientRequest.on('error', (error) => reject(error));
        if (body != null) {
            clientRequest.write(body);
        }
        clientRequest.end();
    });
}

export async function requestJson({data, ...options}: JsonRequest): Promise<JsonResponse> {
    const response = await request({
        ...options,
        body: data == null ? undefined : JSON.stringify(data),
    });
    return {
        ...response,
        data: response.body ? JSON.parse(response.body) : null,
    };
}
