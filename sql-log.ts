/* eslint-disable @typescript-eslint/no-explicit-any */
import { dim, green, red } from './palette';

const verboseLogging = !process.env.AWS_LAMBDA_LOG_GROUP_NAME;
const noFormat: (sql: string, ...params: any[]) => string = (x: string) => x;
const slowQueryThreshold = 200;

function formatDuration(duration: number) {
    const text = `[${duration}ms]`;
    return duration >= slowQueryThreshold ? red(text) : dim(text);
}

export async function logSql<S>(sql: string, params: any[] | undefined, action: () => Promise<S>): Promise<S> {
    let formatSql = noFormat;
    if (verboseLogging) {
        const sqlModule = await import('./sql');
        formatSql = sqlModule.formatSql;
    }
    const formattedSql = formatSql(sql, params);
    const startTime = new Date().getTime();
    try {
        const result: any = await action();
        const duration = new Date().getTime() - startTime;
        let rowCount: number | null = null;
        if (Array.isArray(result)) {
            rowCount = result.length;
        } else if (result.rowCount != null) {
            rowCount = result.rowCount;
        }
        let rowText;
        if (rowCount == null) {
            rowText = '';
        } else if (rowCount === 1) {
            rowText = `1 row `;
        } else {
            rowText = `${rowCount} rows `;
        }
        // eslint-disable-next-line no-console
        console.debug(`${formattedSql} => ${green('✔︎')} ${dim(`${rowText}`)}${formatDuration(duration)}`);
        return result;
    } catch (error) {
        const duration = new Date().getTime() - startTime;
        const { code, message } = error;
        // eslint-disable-next-line no-console
        console.debug(
            `${formattedSql} => ${red(message || '×')} ${dim(`${code ? `#${code} ` : ''}`)}${formatDuration(duration)}`,
        );
        throw error;
    }
}
