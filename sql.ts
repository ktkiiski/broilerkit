import { Table } from './db';
import { Resource } from './resources';
import { isNotNully } from './utils/compare';
import { Key, keys } from './utils/objects';
import { stripPrefix } from './utils/strings';

export interface SqlQuery<R> {
    sql: string;
    params: any[];
    deserialize(result: SqlResult): R;
}

export interface SqlScanQuery<R> extends SqlQuery<R[]> {
    chunkSize: number;
}

export interface Row {
    [key: string]: any;
}

export interface SqlResult {
    rows: Row[];
    rowCount: number;
}

export function selectQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    filters: Record<string, any>,
    limit?: number,
    ordering?: string,
    direction?: 'asc' | 'desc',
    since?: any,
): SqlQuery<S[]> {
    const params: any[] = [];
    const { name, resource } = table;
    let sql = `SELECT ${returnColumnsSql(name, resource)} FROM ${ref(name)}`;
    const filtersSql = filterConditionSql(name, filters, params);
    const conditions = filtersSql ? [filtersSql] : [];
    if (ordering && direction && since != null) {
        params.push(since);
        const dirOp = direction === 'asc' ? '>' : '<';
        conditions.push(`${ref(ordering)} ${dirOp} $${params.length}`);
    }
    if (conditions.length) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    if (ordering && direction) {
        sql += ` ORDER BY ${ref(ordering)} ${direction.toUpperCase()}`;
    }
    if (limit != null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
    }
    sql += ';';
    return makeQuery(sql, params, ({ rows }) => (
        rows.map((row) => parseRow(name, table, row)).filter(isNotNully)
    ));
}

export function batchSelectQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    filtersList: Array<Record<string, any>>,
): SqlQuery<S[]> {
    const { name, resource } = table;
    const params: any[] = [];
    let sql = `SELECT ${returnColumnsSql(name, resource)} FROM ${ref(name)}`;
    const orConditions = filtersList.map((filters) => (
        `(${filterConditionSql(name, filters, params)})`
    ));
    sql += ` WHERE ${orConditions.join(' OR ')};`;
    return makeQuery(sql, params, ({ rows }) => (
        rows.map((row) => parseRow(name, table, row)).filter(isNotNully)
    ));
}

export function updateQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious: false,
): SqlQuery<S[]>;
export function updateQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious: true,
): SqlQuery<Array<[S, S]>>;
export function updateQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious?: boolean,
): SqlQuery<S[] | Array<[S, S]>>;
export function updateQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious: boolean = false,
): SqlQuery<S[] | Array<[S, S]>> {
    const params: any[] = [];
    const assignments: string[] = [];
    const { name, resource } = table;
    const { fields, identifyBy } = table.resource;
    const columns = keys(fields);
    columns.forEach((key) => {
        const value = values[key];
        if (typeof value !== 'undefined' && !identifyBy.includes(key as PK)) {
            assignments.push(assignmentSql(name, key, value, params));
        }
    });
    const tblRef = ref(name);
    const valSql = assignments.join(', ');
    const condSql = filterConditionSql(name, filters, params);
    const returnSql = returnColumnsSql(name, resource);
    if (returnPrevious) {
        // Join the current state to the query in order to return the previous state
        const columnSql = keys(resource.fields).map(ref).join(', ');
        const prevSelect = `SELECT ${columnSql} FROM ${tblRef} WHERE ${condSql} FOR UPDATE`;
        const prevAlias = '_previous';
        const prevRef = ref(prevAlias);
        const joinConditions = identifyBy.map((pk) => (
            `${prevRef}.${ref(pk)} = ${tblRef}.${ref(pk)}`
        ));
        const joinSql = joinConditions.join(' AND ');
        const prevReturnSql = returnColumnsSql(prevAlias, resource);
        const sql = `UPDATE ${tblRef} SET ${valSql} FROM (${prevSelect}) ${prevRef} WHERE ${joinSql} RETURNING ${prevReturnSql}, ${returnSql};`;
        return makeQuery(sql, params, ({ rows }) => (
            rows.map((row) => {
                const newItem = parseRow(name, table, row);
                const oldItem = parseRow('_previous', table, row);
                if (newItem && oldItem) {
                    return [newItem, oldItem] as [S, S];
                }
                return null;
            }).filter(isNotNully)
        ));
    } else {
        // Normal update, without joining the previous state
        const sql = `UPDATE ${tblRef} SET ${valSql} WHERE ${condSql} RETURNING ${returnSql};`;
        return makeQuery(sql, params, ({ rows }) => (
            rows.map((row) => parseRow(name, table, row)).filter(isNotNully)
        ));
    }
}

interface InsertResult<R> {
    item: R;
    wasCreated: boolean;
}

export function insertQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    insertValues: Record<string, any>,
    updateValues: Record<string, any>,
): SqlQuery<InsertResult<S>>;
export function insertQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    insertValues: Record<string, any>,
    updateValues?: Record<string, any>,
): SqlQuery<InsertResult<S> | null>;
export function insertQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    insertValues: Record<string, any>,
    updateValues?: Record<string, any>,
): SqlQuery<InsertResult<S> | null> {
    const params: any[] = [];
    const columns: string[] = [];
    const placeholders: string[] = [];
    const updates: string[] = [];
    const { name, resource } = table;
    const { fields, identifyBy } = resource;
    keys(fields).forEach((key) => {
        columns.push(ref(key));
        params.push(insertValues[key]);
        placeholders.push(`$${params.length}`);
    });
    if (updateValues) {
        keys(updateValues).forEach((key) => {
            const value = updateValues[key];
            updates.push(assignmentSql(name, key, value, params));
        });
    }
    const tblSql = ref(name);
    const colSql = columns.join(', ');
    const valSql = placeholders.join(', ');
    let sql = `INSERT INTO ${tblSql} (${colSql}) VALUES (${valSql})`;
    if (updates.length) {
        const pkSql = identifyBy.map(ref).join(',');
        const upSql = updates.join(', ');
        sql += ` ON CONFLICT (${pkSql}) DO UPDATE SET ${upSql}`;
    } else {
        sql += ` ON CONFLICT DO NOTHING`;
    }
    sql += ` RETURNING ${returnColumnsSql(name, resource)}, xmax::text::int;`;
    return makeQuery(sql, params, ({ rows }) => {
        for (const { xmax, ...row } of rows) {
            const item = parseRow(name, table, row);
            if (item) {
                return { item, wasCreated: xmax === 0 };
            }
        }
        return null;
    });
}

export function deleteQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: Table<S, PK, V, D>,
    filters: Record<string, any>,
): SqlQuery<S | null> {
    const params: any[] = [];
    const { name } = table;
    let sql = `DELETE FROM ${ref(name)}`;
    const conditionSql = filterConditionSql(name, filters, params);
    if (conditionSql) {
        sql += ` WHERE ${conditionSql}`;
    }
    sql += ` RETURNING ${returnColumnsSql(name, table.resource)};`;
    return {
        sql, params,
        deserialize({ rows }) {
            if (!rows.length) {
                return null;
            }
            return parseRow(name, table, rows[0]);
        },
    };
}

export function countQuery(
    table: Table<any, any, any, any>,
    filters: Record<string, any>,
): SqlQuery<number> {
    const params: any[] = [];
    const { name } = table;
    let sql = `SELECT COUNT(*)::int AS count FROM ${ref(name)}`;
    const filtersSql = filterConditionSql(name, filters, params);
    if (filtersSql) {
        sql += ` WHERE ${filtersSql}`;
    }
    sql += ';';
    return makeQuery(sql, params, ({ rows }) => rows[0]?.count ?? 0);
}

class Increment {
    constructor(public readonly diff: number) {}
}

export function increment(diff: number) {
    return new Increment(diff);
}

function assignmentSql(tableName: string, field: string, value: any, params: any[]): string {
    if (value instanceof Increment) {
        // Make an increment statement
        params.push(value.diff);
        return `${ref(field)} = COALESCE(${ref(tableName)}.${ref(field)}, 0) + $${params.length}`;
    }
    params.push(value);
    return `${ref(field)} = $${params.length}`;
}

function filterSql(tableName: string, field: string, value: any, params: any[]): string {
    const colRef = ref(tableName) + '.' + ref(field);
    if (value == null) {
        return `${colRef} IS NULL`;
    }
    if (Array.isArray(value)) {
        if (!value.length) {
            // would result in `xxxx IN ()` which won't work
            return `FALSE`;
        }
        const placeholders = value.map((item) => {
            params.push(item);
            return `$${params.length}`;
        });
        return `${colRef} IN (${placeholders.join(',')})`;
    }
    params.push(value);
    return `${colRef} = $${params.length}`;
}

function filterConditionSql(tableName: string, filters: {[field: string]: any}, params: any[]): string {
    const conditions = keys(filters).map((field) => (
        filterSql(tableName, field, filters[field], params)
    ));
    return conditions.join(' AND ');
}

function returnColumnsSql(tableName: string, resource: Resource<any, any, any>): string {
    const columnSqls = keys(resource.fields).map((column) => (
        `${ref(tableName)}.${ref(column)} AS ${ref(tableName + '.' + column)}`
    ));
    return columnSqls.join(', ');
}

function ref(identifier: string) {
    return JSON.stringify(identifier);
}

function makeQuery<R>(sql: string, params: any[], deserialize: (result: SqlResult) => R): SqlQuery<R> {
    return { sql, params, deserialize };
}

function parseRow<S, PK extends Key<S>>(tableAlias: string, table: Table<S, PK, any, any>, row: Row): S | null {
    const { defaults, resource } = table;
    const propertyPrefix = tableAlias + '.';
    const item: Row = {};
    Object.keys(row).forEach((key) => {
        const propertyName = stripPrefix(key, propertyPrefix);
        if (propertyName != null) {
            item[propertyName] = row[key];
        }
    });
    const result = Object.keys(defaults).reduce(
        (obj, key) => {
            const defaultValue = defaults[key];
            if (obj[key as keyof S] == null && defaultValue != null) {
                return { ...obj, [key]: defaultValue };
            }
            return obj;
        },
        item as S,
    );
    try {
        return resource.validate(result as S);
    } catch (error) {
        // The database entry is not valid!
        const identity: {[key: string]: any} = {};
        resource.identifyBy.forEach((key) => {
            identity[key] = result[key];
        });
        // tslint:disable-next-line:no-console
        console.error(`Failed to load invalid record ${JSON.stringify(identity)} from the database:`, error);
        return null;
    }
}
