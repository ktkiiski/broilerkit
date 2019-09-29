// tslint:disable:no-console
import { SecretsManager } from 'aws-sdk';
import * as https from 'https';
import { Client } from 'pg';
import * as url from 'url';

type RequestType = 'Create' | 'Update' | 'Delete';

interface TableColumn {
    name: string;
    type: string;
}

interface TableIndex {
    keys: string[];
}

export interface TableState {
    name: string;
    primaryKeys: TableColumn[];
    columns: TableColumn[];
    indexes: TableIndex[];
}

interface MigrationCRFProperties {
    Host: string;
    Database: string;
    Port: number;
    SecretId: string;
    Region: string;
    Table: TableState;
}

interface MigrationCFRRequest {
    RequestType: RequestType;
    ResponseURL: string;
    StackId: string;
    ResourceType: string;
    LogicalResourceId: string;
    PhysicalResourceId?: string;
    RequestId: string;
    ResourceProperties: MigrationCRFProperties;
    OldResourceProperties?: MigrationCRFProperties;
}

function escapeRef(identifier: string) {
    return JSON.stringify(identifier);
}

function getTablePid(parameters: MigrationCRFProperties) {
    return `${parameters.Database}:${parameters.Table}`;
}

function getIndexName(index: TableIndex, tableName: string): string {
    return `idx_${tableName}_${index.keys.join('_')}`;
}

export async function createTable(client: Client, state: TableState) {
    const pkColumns = state.primaryKeys;
    const tableName = state.name;
    const pkKeys = pkColumns.map((col) => escapeRef(col.name)).join(', ');
    const pkDefs = pkColumns.map((col) => `${escapeRef(col.name)} ${col.type} NOT NULL`).join(', ');
    const sql = `CREATE TABLE IF NOT EXISTS ${escapeRef(tableName)} (${pkDefs}, PRIMARY KEY (${pkKeys}));`;
    console.log(sql);
    await client.query(sql);
    console.info(`Successfully created the table ${tableName}`);
    // Need to create the other columns of the table
    return updateTable(client, state, undefined);
}
export async function deleteTable(client: Client, state: TableState) {
    const tableName = state.name;
    const sql = `DROP TABLE IF EXISTS ${escapeRef(tableName)};`;
    console.log(sql);
    await client.query(sql);
    console.info(`Successfully dropped the table ${tableName}`);
}
export async function updateTable(client: Client, state: TableState, oldState: TableState | undefined) {
    const tableName = state.name;
    const oldTableName = oldState && oldState.name;
    const columns = state.columns;
    if (oldTableName && tableName !== oldTableName) {
        // Renamte the table
        const sql = `ALTER TABLE ${escapeRef(oldTableName)} RENAME TO ${escapeRef(tableName)};`;
        console.log(sql);
        await client.query(sql);
        console.info(`Renamed the table ${oldTableName} as ${tableName}`);
    }
    for (const column of columns) {
        const sql = `ALTER TABLE ${escapeRef(tableName)} ADD COLUMN IF NOT EXISTS ${escapeRef(column.name)} ${column.type} NULL;`;
        console.log(sql);
        await client.query(sql);
        console.info(`Upserted the column ${column.name} to table ${tableName}`);
    }
    // Create and delete indexes
    const newIndexes = state.indexes.map((index) => ({
        name: getIndexName(index, tableName), ...index,
    }));
    const newIndexNames = newIndexes.map((index) => index.name);
    const oldIndexNames = (oldState ? oldState.indexes : [])
        .map((index) => getIndexName(index, tableName));
    // Create new index
    const createdIndexes = newIndexes.filter((index) => !oldIndexNames.includes(index.name));
    for (const index of createdIndexes) {
        const colDefs = index.keys.map(escapeRef).join(', ');
        const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${escapeRef(index.name)} ON ${escapeRef(tableName)} (${colDefs});`;
        console.log(sql);
        await client.query(sql);
        console.info(`Successfully created the index ${index.name} on table ${tableName} for keys: ${colDefs}`);
    }
    // Delete each index that no longer exist
    const deletedIndexNames = oldIndexNames.filter((idxName) => !newIndexNames.includes(idxName));
    for (const indexName of deletedIndexNames) {
        const sql = `DROP INDEX CONCURRENTLY ${escapeRef(indexName)};`;
        console.log(sql);
        await client.query(sql);
        console.info(`Successfully deleted the index ${indexName} from table ${tableName}`);
    }
}

function respond(ev: MigrationCFRRequest, status: 'SUCCESS' | 'FAILED', reason: string, data: any) {
    const tablePid = getTablePid(ev.ResourceProperties);
    console.log(`Database table physical ID: ${tablePid} (${status})`);
    const response = {
        Status: status,
        Reason: reason,
        PhysicalResourceId: ev.PhysicalResourceId || tablePid,
        StackId: ev.StackId,
        RequestId: ev.RequestId,
        LogicalResourceId: ev.LogicalResourceId,
        Data: data,
    };
    const { hostname, path } = url.parse(ev.ResponseURL);
    const request = { hostname, path, method: 'PUT' };
    return new Promise((resolve, reject) => {
        https.request(request, resolve)
            .on('error', (error) => {
                console.error('Failed to respond to the custom resource request:', error);
                reject(error);
            })
            .end(JSON.stringify(response))
        ;
    });
}

async function getCredentials(parameters: MigrationCRFProperties): Promise<{ username: string, password: string }> {
    const { SecretId, Region } = parameters;
    const sdk = new SecretsManager({
        apiVersion: '2017-10-17',
        region: Region,
        httpOptions: { timeout: 10 * 1000 },
        maxRetries: 5,
    });
    console.log(`Resolving username/password using secret ${SecretId} at region ${Region}`);
    const response = await sdk.getSecretValue({ SecretId }).promise();
    const secret = response.SecretString;
    if (!secret) {
        throw new Error('Response does not contain a SecretString');
    }
    const { username, password } = JSON.parse(secret);
    console.log(`Resolved username & password: ${username} / ${password.replace(/./g, '*')}`);
    return { username, password };
}

export async function migrate(ev: MigrationCFRRequest) {
    const operation: RequestType = ev.RequestType;
    const parameters = ev.ResourceProperties;
    const { username, password } = await getCredentials(parameters);
    console.log(`Performing ${operation} to table ${parameters.Table} at postregsql://${username}@${parameters.Host}:${parameters.Port}/${parameters.Database}`);
    const oldParameters = ev.OldResourceProperties;
    const table = parameters && parameters.Table;
    const oldTable = oldParameters && oldParameters.Table;
    if (oldParameters) {
        const newDatabase = parameters.Database;
        const oldDatabase = oldParameters.Database;
        if (oldDatabase !== newDatabase) {
            throw new Error(`Database table cannot be moved from database ${oldDatabase} to ${newDatabase}!`);
        }
    }
    const client = new Client({
        host: parameters.Host,
        database: parameters.Database,
        port: parameters.Port,
        user: username,
        password,
        connectionTimeoutMillis: 30 * 1000,
        statement_timeout: 5 * 60 * 1000,
    });
    await client.connect();
    try {
        if (operation === 'Create') {
            await createTable(client, table);
        } else if (operation === 'Update') {
            await updateTable(client, table, oldTable);
        } else if (operation === 'Delete') {
            await deleteTable(client, table);
        }
    } finally {
        await client.end();
    }
}

export async function handler(ev: MigrationCFRRequest, ctx: { done: () => void }) {
    try {
        console.log('Performing database migration with properties:', ev.ResourceProperties);
        if (ev.OldResourceProperties) {
            console.log('Previous properties were:', ev.OldResourceProperties);
        }
        await migrate(ev);
        console.log('Migration successful!');
        await respond(ev, 'SUCCESS', '', {});
        console.log('Responsed to CloudFormation request successfully!');
    } catch (error) {
        console.error('Migration operation failed with error', error);
        const reason = (error && error.message) || '';
        await respond(ev, 'FAILED', reason, error);
        console.log('Responed to CloudFormation request successfully with reason:', reason);
    } finally {
        ctx.done();
    }
}
