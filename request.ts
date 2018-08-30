import * as http from 'http';
import * as https from 'https';
import { HttpMethod } from './http';

interface Request extends https.RequestOptions {
    url: string;
    method: HttpMethod;
    body?: string;
}

interface JsonRequest extends https.RequestOptions {
    url: string;
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

declare module 'https' {
    export function request(url: string | URL, options: RequestOptions, callback?: (res: http.IncomingMessage) => void): http.ClientRequest;
}

export function request({url, body, ...options}: Request): Promise<Response> {
    return new Promise((resolve, reject) => {
        const clientRequest = https.request(url, options, (resp) => {
            // tslint:disable-next-line:no-shadowed-variable
            let body = '';
            resp.on('data', (chunk) => { body += chunk; });
            resp.on('end', () => {
                const {statusCode, headers} = resp;
                if (statusCode) {
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
