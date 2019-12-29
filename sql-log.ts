const verboseLogging = !process.env.AWS_LAMBDA_LOG_GROUP_NAME;
const noFormat = (x: string, ..._: any[]) => x;

export async function logSql<S>(sql: string, params: any[] | undefined, action: () => Promise<S>): Promise<S> {
    let formatSql = noFormat;
    let green = noFormat;
    let red = noFormat;
    let dim = noFormat;
    if (verboseLogging) {
        const sqlModule = await import('./sql');
        const chalk = await import('chalk');
        formatSql = sqlModule.formatSql;
        green = chalk.green;
        red = chalk.red;
        dim = chalk.dim;
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
        const rowText = rowCount == null ? '' : rowCount === 1 ? `1 row ` : `${rowCount} rows `;
        // tslint:disable-next-line:no-console
        console.debug(`${formattedSql} => ${green('✔︎')} ${dim(`${rowText}[${duration}ms]`)}`);
        return result;
    } catch (error) {
        const duration = new Date().getTime() - startTime;
        const { code, message } = error;
        // tslint:disable-next-line:no-console
        console.debug(`${formattedSql} => ${red(message || '×')} ${dim(`${code ? `#${code} ` : ''}[${duration}ms]`)}`);
        throw error;
    }
}
