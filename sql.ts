import { TableDefinition } from './db';
import { Resource } from './resources';
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
    const { name, resource } = table;
    let sql = `SELECT ${returnColumnsSql(name, resource)} FROM ${ref(name)}`;
    const conditions = Object.keys(filters).map((filterKey) => {
        const filterValue = filters[filterKey];
        return filterSql(name, filterKey, filterValue, params);
    });
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
    return { sql, params };
}

export function batchSelectQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: TableDefinition<S, PK, V, D>,
    filtersList: Array<Record<string, any>>,
): SqlQuery {
    const { name, resource } = table;
    const params: any[] = [];
    let sql = `SELECT ${returnColumnsSql(name, resource)} FROM ${ref(name)}`;
    const orConditions = filtersList.map((filters) => {
        const andConditions = keys(filters).map((filterKey) => {
            const filterValue = filters[filterKey];
            return filterSql(name, filterKey, filterValue, params);
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
    const { name, resource } = table;
    const { fields, identifyBy } = table.resource;
    const columns = keys(fields);
    columns.forEach((key) => {
        const value = values[key];
        if (typeof value !== 'undefined' && !identifyBy.includes(key as PK)) {
            assignments.push(assignmentSql(name, key, value, params));
        }
    });
    const conditions = keys(filters).map((filterKey) => {
        const filterValue = filters[filterKey];
        return filterSql(name, filterKey, filterValue, params);
    });
    const tblSql = ref(name);
    const valSql = assignments.join(', ');
    const condSql = conditions.join(' AND ');
    const returningSql = returnColumnsSql(name, resource);
    const sql = `UPDATE ${tblSql} SET ${valSql} WHERE ${condSql} RETURNING ${returningSql};`;
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
    return { sql, params };
}

export function deleteQuery<S, PK extends Key<S>, V extends Key<S>, D>(
    table: TableDefinition<S, PK, V, D>,
    filters: Record<string, any>,
): SqlQuery {
    const params: any[] = [];
    let sql = `DELETE FROM ${ref(table.name)}`;
    const conditions = Object.keys(filters).map((filterKey) => {
        const filterValue = filters[filterKey];
        return filterSql(table.name, filterKey, filterValue, params);
    });
    if (conditions.length) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ` RETURNING ${returnColumnsSql(table.name, table.resource)};`;
    return { sql, params };
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

function returnColumnsSql(tableName: string, resource: Resource<any, any, any>): string {
    const columnSqls = keys(resource.fields).map((column) => (
        `${ref(tableName)}.${ref(column)} AS ${ref(tableName + '.' + column)}`
    ));
    return columnSqls.join(', ');
}

function ref(identifier: string) {
    return JSON.stringify(identifier);
}
