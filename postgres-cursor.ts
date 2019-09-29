import { ClientBase } from 'pg';
const Cursor = require('pg-cursor');

export async function *scanCursor<S>(client: ClientBase, chunkSize: number, sql: string, values?: any[]) {
    const cursor = client.query(new Cursor(sql, values));
    try {
        while (true) {
            const items = await new Promise<S[]>((resolve, reject) => {
                cursor.read(chunkSize, (error: any, rows: S[]) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(rows);
                    }
                });
            });
            if (items.length) {
                yield items;
            }
            if (!items.length || items.length < chunkSize) {
                break;
            }
        }
    } finally {
        await new Promise((resolve, reject) => {
            cursor.close((error: any) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }
}
