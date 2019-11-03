import { TableDefinition } from './db';
import { Key, keys } from './utils/objects';

export interface SqlQuery {
    sql: string;
    params: any[];
}

export function selectQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: TableDefinition<S, PK, V, D>,
    filters: Record<string, any>,
    limit?: number,
    ordering?: string,
    direction?: 'asc' | 'desc',
    since?: any,
): SqlQuery {
    const params: any[] = [];
    const columnNames = Object.keys(table.resource.fields).map(escapeRef);
    let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(table.name)}`;
    const conditions = Object.keys(filters).map((filterKey) => {
        const filterValue = filters[filterKey];
        return makeComparison(filterKey, filterValue, params);
    });
    if (ordering && direction && since != null) {
        params.push(since);
        const dirOp = direction === 'asc' ? '>' : '<';
        conditions.push(`${escapeRef(ordering)} ${dirOp} $${params.length}`);
    }
    if (conditions.length) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    if (ordering && direction) {
        sql += ` ORDER BY ${escapeRef(ordering)} ${direction.toUpperCase()}`;
    }
    if (limit != null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
    }
    sql += ';';
    return { sql, params };
}

export function batchSelectQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: TableDefinition<S, PK, V, D>,
    filtersList: Array<Record<string, any>>,
): SqlQuery {
    const params: any[] = [];
    const columnNames = Object.keys(table.resource.fields).map(escapeRef);
    let sql = `SELECT ${columnNames.join(', ')} FROM ${escapeRef(table.name)}`;
    const orConditions = filtersList.map((filters) => {
        const andConditions = keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return makeComparison(filterKey, filterValue, params);
        });
        return `(${andConditions.join(' AND ')})`;
    });
    sql += ` WHERE ${orConditions.join(' OR ')};`;
    return { sql, params };
}

export function updateQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: TableDefinition<S, PK, V, D>,
    filters: Record<string, any>,
    values: Record<string, any>,
): SqlQuery {
    const params: any[] = [];
    const assignments: string[] = [];
    const { fields, identifyBy } = table.resource;
    const columns = keys(fields);
    columns.forEach((key) => {
        const value = values[key];
        if (typeof value !== 'undefined' && !identifyBy.includes(key as PK)) {
            assignments.push(makeAssignment(key, value, params));
        }
    });
    const conditions = keys(filters).map((filterKey) => {
        const filterValue = filters[filterKey];
        return makeComparison(filterKey, filterValue, params);
    });
    const tblSql = escapeRef(table.name);
    const valSql = assignments.join(', ');
    const condSql = conditions.join(' AND ');
    const colSql = columns.map(escapeRef).join(', ');
    const sql = `UPDATE ${tblSql} SET ${valSql} WHERE ${condSql} RETURNING ${colSql};`;
    return { sql, params };
}

export function insertQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: TableDefinition<S, PK, V, D>,
    insertValues: Record<string, any>,
    updateValues?: Record<string, any>,
): SqlQuery {
    const params: any[] = [];
    const columns: string[] = [];
    const placeholders: string[] = [];
    const updates: string[] = [];
    const { fields, identifyBy } = table.resource;
    keys(fields).forEach((key) => {
        columns.push(escapeRef(key));
        params.push(insertValues[key]);
        placeholders.push(`$${params.length}`);
    });
    if (updateValues) {
        keys(updateValues).forEach((key) => {
            updates.push(makeAssignment(key, updateValues[key], params));
        });
    }
    const tblSql = escapeRef(table.name);
    const colSql = columns.join(', ');
    const valSql = placeholders.join(', ');
    let sql = `INSERT INTO ${tblSql} (${colSql}) VALUES (${valSql})`;
    if (updates.length) {
        const pkSql = identifyBy.map(escapeRef).join(',');
        const upSql = updates.join(', ');
        sql += ` ON CONFLICT (${pkSql}) DO UPDATE SET ${upSql}`;
    } else {
        sql += ` ON CONFLICT DO NOTHING`;
    }
    sql += ` RETURNING ${colSql}, xmax::text::int;`;
    return { sql, params };
}

export function deleteQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: TableDefinition<S, PK, V, D>,
    filters: Record<string, any>,
): SqlQuery {
    const { fields } = table.resource;
    const params: any[] = [];
    const colSql = keys(fields).map(escapeRef).join(', ');
    let sql = `DELETE FROM ${escapeRef(table.name)}`;
    const conditions = Object.keys(filters).map((filterKey) => {
        const filterValue = filters[filterKey];
        return makeComparison(filterKey, filterValue, params);
    });
    if (conditions.length) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ` RETURNING ${colSql};`;
    return { sql, params };
}

class Increment {
    constructor(public readonly diff: number) {}
}

export function increment(diff: number) {
    return new Increment(diff);
}

function makeAssignment(field: string, value: any, params: any[]): string {
    if (value instanceof Increment) {
        // Make an increment statement
        params.push(value.diff);
        return `${escapeRef(field)} = COALESCE(${escapeRef(field)}, 0) + $${params.length}`;
    }
    params.push(value);
    return `${escapeRef(field)} = $${params.length}`;
}

function makeComparison(field: string, value: any, params: any[]): string {
    if (value == null) {
        return `${escapeRef(field)} IS NULL`;
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
        return `${escapeRef(field)} IN (${placeholders.join(',')})`;
    }
    params.push(value);
    return `${escapeRef(field)} = $${params.length}`;
}

function escapeRef(identifier: string) {
    return JSON.stringify(identifier);
}
