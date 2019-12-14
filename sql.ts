import chalk from 'chalk';
import { Fields, Serializer } from './serializers';
import { isNotNully } from './utils/compare';
import { Key, keys } from './utils/objects';

const { cyan, magenta, dim } = chalk;

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

export interface SqlNesting {
    alias: string;
    queryable: SqlQueryable<any>;
    on: {[key: string]: string};
}

export interface SqlJoin {
    alias: string;
    queryable: SqlQueryable<any>;
    on: {[key: string]: string};
    columns: {[column: string]: string};
}

export interface SqlQueryable<S, PK extends Key<S> = Key<S>> {
    name: string;
    resource: Serializer<S>;
    primaryKeys: PK[];
    defaults: { [P in any]: S[any] };
    columns: Fields<S>;
    nestings: SqlNesting[];
    joins: SqlJoin[];
}

export interface SqlWriteable<S, PK extends Key<S> = Key<S>> {
    name: string;
    resource: Serializer<S>;
    primaryKeys: PK[];
    columns: Fields<S>;
    defaults: { [P in any]: S[any] };
}

export function selectQuery<S>(
    table: SqlQueryable<S>,
    filters: Record<string, any>,
    limit?: number,
    ordering?: string,
    direction?: 'asc' | 'desc',
    since?: any,
): SqlQuery<S[]> {
    const params: any[] = [];
    const { name, resource, defaults } = table;
    let sql = `SELECT ${getSelectColumnsSql(table)} FROM ${ref(name)}`;
    sql += getJoinSql(name, table);
    const filtersSql = filterConditionSql(filters, table, params);
    const conditions = filtersSql ? [filtersSql] : [];
    if (ordering && direction && since != null) {
        params.push(since);
        const dirOp = direction === 'asc' ? '>' : '<';
        conditions.push(`${ref(name)}.${ref(ordering)} ${dirOp} $${params.length}`);
    }
    if (conditions.length) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    if (ordering && direction) {
        sql += ` ORDER BY ${ref(name)}.${ref(ordering)} ${direction.toUpperCase()}`;
    }
    if (limit != null) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
    }
    sql += ';';
    return makeQuery(sql, params, ({ rows }) => (
        rows.map((row) => parseRow(name, resource, defaults, row)).filter(isNotNully)
    ));
}

export function batchSelectQuery<S>(
    table: SqlQueryable<S>,
    filtersList: Array<Record<string, any>>,
): SqlQuery<S[]> {
    const { name, columns, resource } = table;
    const params: any[] = [];
    let sql = `SELECT ${returnColumnsSql(name, columns)} FROM ${ref(name)}`;
    const orConditions = filtersList.map((filters) => (
        `(${filterConditionSql(filters, table, params)})`
    ));
    sql += ` WHERE ${orConditions.join(' OR ')};`;
    return makeQuery(sql, params, ({ rows }) => (
        rows.map((row) => parseRow(name, resource, table.defaults, row)).filter(isNotNully)
    ));
}

export function updateQuery<S>(
    table: SqlWriteable<S>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious: false,
): SqlQuery<S[]>;
export function updateQuery<S>(
    table: SqlWriteable<S>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious: true,
): SqlQuery<Array<[S, S]>>;
export function updateQuery<S>(
    table: SqlWriteable<S>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious?: boolean,
): SqlQuery<S[] | Array<[S, S]>>;
export function updateQuery<S>(
    table: SqlWriteable<S>,
    filters: Record<string, any>,
    values: Record<string, any>,
    returnPrevious: boolean = false,
): SqlQuery<S[] | Array<[S, S]>> {
    const params: any[] = [];
    const assignments: string[] = [];
    const { name, columns, primaryKeys, resource, defaults } = table;
    keys(columns).forEach((key) => {
        const value = values[key];
        if (typeof value !== 'undefined' && !primaryKeys.includes(key as Key<S>)) {
            assignments.push(assignmentSql(name, key, value, params));
        }
    });
    const tblRef = ref(name);
    const valSql = assignments.join(', ');
    const condSql = filterConditionSql(filters, table, params);
    const returnSql = returnColumnsSql(name, columns);
    if (returnPrevious) {
        // Join the current state to the query in order to return the previous state
        const columnSql = keys(columns).map(ref).join(', ');
        const prevSelect = `SELECT ${columnSql} FROM ${tblRef} WHERE ${condSql} FOR UPDATE`;
        const prevAlias = '_previous';
        const prevRef = ref(prevAlias);
        const joinConditions = primaryKeys.map((pk) => (
            `${prevRef}.${ref(pk)} = ${tblRef}.${ref(pk)}`
        ));
        const joinSql = joinConditions.join(' AND ');
        const prevReturnSql = returnColumnsSql(prevAlias, columns);
        const sql = `UPDATE ${tblRef} SET ${valSql} FROM (${prevSelect}) ${prevRef} WHERE ${joinSql} RETURNING ${prevReturnSql}, ${returnSql};`;
        return makeQuery(sql, params, ({ rows }) => (
            rows.map((row) => {
                const newItem = parseRow(name, resource, defaults, row);
                const oldItem = parseRow('_previous', resource, defaults, row);
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
            rows.map((row) => parseRow(name, resource, defaults, row)).filter(isNotNully)
        ));
    }
}

interface InsertResult<R> {
    item: R;
    wasCreated: boolean;
}

export function insertQuery<S>(
    table: SqlWriteable<S>,
    insertValues: Record<string, any>,
    updateValues: Record<string, any>,
): SqlQuery<InsertResult<S>>;
export function insertQuery<S>(
    table: SqlWriteable<S>,
    insertValues: Record<string, any>,
    updateValues?: Record<string, any>,
): SqlQuery<InsertResult<S> | null>;
export function insertQuery<S>(
    table: SqlWriteable<S>,
    insertValues: Record<string, any>,
    updateValues?: Record<string, any>,
): SqlQuery<InsertResult<S> | null> {
    const params: any[] = [];
    const columnNames: string[] = [];
    const placeholders: string[] = [];
    const updates: string[] = [];
    const { name, resource, columns, primaryKeys } = table;
    keys(columns).forEach((key) => {
        columnNames.push(ref(key));
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
    const colSql = columnNames.join(', ');
    const valSql = placeholders.join(', ');
    let sql = `INSERT INTO ${tblSql} (${colSql}) VALUES (${valSql})`;
    if (updates.length) {
        const pkSql = primaryKeys.map(ref).join(',');
        const upSql = updates.join(', ');
        sql += ` ON CONFLICT (${pkSql}) DO UPDATE SET ${upSql}`;
    } else {
        sql += ` ON CONFLICT DO NOTHING`;
    }
    sql += ` RETURNING ${returnColumnsSql(name, columns)}, xmax::text::int;`;
    return makeQuery(sql, params, ({ rows }) => {
        for (const { xmax, ...row } of rows) {
            const item = parseRow(name, resource, table.defaults, row);
            if (item) {
                return { item, wasCreated: xmax === 0 };
            }
        }
        return null;
    });
}

export function deleteQuery<S>(
    table: SqlWriteable<S>,
    filters: Record<string, any>,
): SqlQuery<S | null> {
    const params: any[] = [];
    const { name, resource } = table;
    let sql = `DELETE FROM ${ref(name)}`;
    const conditionSql = filterConditionSql(filters, table, params);
    if (conditionSql) {
        sql += ` WHERE ${conditionSql}`;
    }
    sql += ` RETURNING ${returnColumnsSql(name, table.columns)};`;
    return {
        sql, params,
        deserialize({ rows }) {
            if (!rows.length) {
                return null;
            }
            return parseRow(name, resource, table.defaults, rows[0]);
        },
    };
}

export function countQuery(
    table: SqlQueryable<any>,
    filters: Record<string, any>,
): SqlQuery<number> {
    const params: any[] = [];
    const { name } = table;
    let sql = `SELECT COUNT(*)::int AS count FROM ${ref(name)}`;
    const filtersSql = filterConditionSql(filters, table, params);
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

function getSelectColumnsSql(table: SqlQueryable<any>, name = table.name): string {
    const selectSqls = [returnColumnsSql(name, table.columns)];
    // Regular joins
    for (const { alias, columns } of table.joins) {
        const joinName = `${name}.${alias}`;
        for (const columnName of Object.keys(columns)) {
            const sourceName = columns[columnName];
            selectSqls.push(selectColumn(joinName, sourceName, `${name}.${columnName}`));
        }
    }
    // Nesting joins
    for (const { queryable, alias } of table.nestings) {
        selectSqls.push(getSelectColumnsSql(queryable, `${name}.${alias}`));
    }
    return selectSqls.join(', ');
}

function getJoinSql(baseName: string, table: SqlQueryable<any>): string {
    const joinSqlCmps: string[] = [];
    // Regular inner joins
    for (const { alias, on, queryable } of table.joins) {
        const joinName = `${baseName}.${alias}`;
        const joinConditions: string[] = [];
        Object.keys(on).forEach((targetKey) => {
            for (const [sourceTable, sourceKey] of resolveColumnRefs(baseName, on[targetKey], table)) {
                joinConditions.push(
                    `${ref(joinName)}.${ref(targetKey)} = ${ref(sourceTable)}.${ref(sourceKey)}`,
                );
            }
        });
        const onSql = joinConditions.join(' AND ');
        joinSqlCmps.push(` INNER JOIN ${ref(queryable.name)} AS ${ref(joinName)} ON ${onSql}`);
        joinSqlCmps.push(getJoinSql(joinName, queryable));
    }
    // Nesting joins
    for (const { queryable, alias, on } of table.nestings) {
        const joinName = `${baseName}.${alias}`;
        const joinConditions: string[] = [];
        Object.keys(on).forEach((targetKey) => {
            for (const [sourceTable, sourceKey] of resolveColumnRefs(baseName, on[targetKey], table)) {
                joinConditions.push(
                    `${ref(joinName)}.${ref(targetKey)} = ${ref(sourceTable)}.${ref(sourceKey)}`,
                );
            }
        });
        const onSql = joinConditions.join(' AND ');
        joinSqlCmps.push(` LEFT JOIN ${ref(queryable.name)} AS ${ref(joinName)} ON ${onSql}`);
        joinSqlCmps.push(getJoinSql(joinName, queryable));
    }
    return joinSqlCmps.join('');
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

function resolveColumnRefs(baseName: string, columnName: string, table: SqlQueryable<any> | SqlWriteable<any>): Array<[string, string]> {
    const refs: Array<[string, string]> = [];
    if ('joins' in table) {
        for (const join of table.joins) {
            const joinName = `${baseName}.${join.alias}`;
            const source = join.columns[columnName];
            if (source != null) {
                refs.push([joinName, source]);
            }
            Object.keys(join.on).forEach((targetKey) => {
                const sourceKey = join.on[targetKey];
                if (sourceKey === columnName && !refs.some(([x, y]) => x === joinName && y === targetKey)) {
                    refs.push([joinName, targetKey]);
                }
            });
        }
    }
    if (table.columns[columnName]) {
        refs.push([baseName, columnName]);
    }
    if (refs.length) {
        return refs;
    }
    throw new Error(`Unknown column "${columnName}"`);
}

function filterConditionSql(filters: {[field: string]: any}, table: SqlQueryable<any> | SqlWriteable<any>, params: any[]): string {
    const conditions: string[] = [];
    keys(filters).map((field) => {
        const value = filters[field];
        if (typeof value !== 'undefined') {
            for (const [tableName, column] of resolveColumnRefs(table.name, field, table)) {
                conditions.push(filterSql(tableName, column, filters[field], params));
            }
        }
    });
    return conditions.join(' AND ');
}

function selectColumn(tableName: string, columnName: string, alias: string) {
    return `${ref(tableName)}.${ref(columnName)} AS ${ref(alias)}`;
}

function returnColumnsSql(tableName: string, columns: Fields<any>): string {
    const columnSqls = keys(columns).map((column) => (
        selectColumn(tableName, column, `${tableName}.${column}`)
    ));
    return columnSqls.join(', ');
}

function ref(identifier: string) {
    return !keywords.includes(identifier.toUpperCase()) && /^[a-z][a-z0-9]*$/.test(identifier)
        ? identifier : `"${identifier.replace(/"/g, '""')}"`;
}

function escapeValue(value: unknown): string {
    if (value == null) {
        return 'NULL';
    }
    if (value === false) {
        return 'FALSE';
    }
    if (value === true) {
        return 'TRUE';
    }
    if (value instanceof Date) {
        return escapeValue(value.toISOString());
    }
    if (typeof value === 'object') {
        return `${escapeValue(JSON.stringify(value))}::jsonb`;
    }
    const str = String(value);
    if (typeof value === 'number') {
        return str;
    }
    return `'${str.replace(/'/g, '\'\'')}'`;
}

function makeQuery<R>(sql: string, params: any[], deserialize: (result: SqlResult) => R): SqlQuery<R> {
    return { sql, params, deserialize };
}

function cleanupNullNestings(item: Row): Row | null {
    if (item == null || typeof item !== 'object' || Array.isArray(item) || item instanceof Date) {
        return item;
    }
    let allNull = true;
    const result = Object.keys(item).reduce(
        (obj, key) => {
            const currentValue = obj[key];
            if (currentValue != null) {
                allNull = false;
                const cleanValue = cleanupNullNestings(currentValue);
                if (cleanValue !== currentValue) {
                    return { ...obj, [key]: cleanValue };
                }
            }
            return obj;
        },
        item,
    );
    return allNull ? null : result;
}

function fillDefaultValues<S>(item: S, defaults: {[P in any]: S[any]}) {
    return Object.keys(defaults).reduce((obj, key) => {
        const defaultValue = defaults[key];
        if (obj[key as keyof S] == null && defaultValue != null) {
            return { ...obj, [key]: defaultValue };
        }
        return obj;
    }, item);
}

function parseRow<S>(
    tableAlias: string,
    resource: Serializer<S>,
    defaults: {[P in any]: S[any]},
    row: Row,
): S | null {
    const item: Row = {};
    Object.keys(row).forEach((key) => {
        let obj = item;
        const value = row[key];
        const propertyPath = key.split('.');
        const rootProperty = propertyPath.shift() as string;
        if (rootProperty !== tableAlias) {
            return;
        }
        while (propertyPath.length > 1) {
            const property = propertyPath.shift() as string;
            obj = (obj[property] = (obj[property] ?? {}));
        }
        obj[propertyPath[0]] = value;
    });
    const cleanItem = cleanupNullNestings(item);
    if (cleanItem == null) {
        return null;
    }
    const result = fillDefaultValues(cleanItem, defaults);
    try {
        return resource.validate(result as S);
    } catch (error) {
        // The database entry is not valid!
        // tslint:disable-next-line:no-console
        console.error(`Failed to load invalid ${tableAlias} item from the database:`, error);
        return null;
    }
}

const sqlTokenizerRegexp = /("(?:""|[^"])*"|'(?:''|[^'])*'|\s+|[;,\(\)\[\]])/g;

function tokenize(sql: string): string[] {
    return sql.split(sqlTokenizerRegexp).filter((token) => !!token);
}

export function formatSql(sql: string, params: any[] = []) {
    const tokens = tokenize(sql);
    const keywordColor = tokens.length && tokens[0] !== 'SELECT' ? cyan : magenta;
    const colorizedTokens = tokenize(sql).map((token) => {
        const upperToken = token.toUpperCase();
        if (minorKeywords.includes(upperToken)) {
            return dim(keywordColor(token));
        }
        if (keywords.includes(upperToken)) {
            return keywordColor(token);
        }
        const paramMatch = /^\$(\d+)$/.exec(token);
        if (paramMatch) {
            const value = params[parseInt(paramMatch[1], 10) - 1];
            return escapeValue(value);
        }
        if (token[0] === ' ' || /^'.*'$/.test(token[0])) {
            return token;
        }
        return dim(token);
    });
    return colorizedTokens.join('');
}

const keywords = [
    'A',
    'ABORT',
    'ABS',
    'ABSOLUTE',
    'ACCESS',
    'ACTION',
    'ADA',
    'ADD',
    'ADMIN',
    'AFTER',
    'AGGREGATE',
    'ALIAS',
    'ALL',
    'ALLOCATE',
    'ALSO',
    'ALTER',
    'ALWAYS',
    'ANALYSE',
    'ANALYZE',
    'AND',
    'ANY',
    'ARE',
    'ARRAY',
    'AS',
    'ASC',
    'ASENSITIVE',
    'ASSERTION',
    'ASSIGNMENT',
    'ASYMMETRIC',
    'AT',
    'ATOMIC',
    'ATTRIBUTE',
    'ATTRIBUTES',
    'AUTHORIZATION',
    'AVG',
    'BACKWARD',
    'BEFORE',
    'BEGIN',
    'BERNOULLI',
    'BETWEEN',
    'BIGINT',
    'BINARY',
    'BIT',
    'BITVAR',
    'BIT_LENGTH',
    'BLOB',
    'BOOLEAN',
    'BOTH',
    'BREADTH',
    'BY',
    'C',
    'CACHE',
    'CALL',
    'CALLED',
    'CARDINALITY',
    'CASCADE',
    'CASCADED',
    'CASE',
    'CAST',
    'CATALOG',
    'CATALOG_NAME',
    'CEIL',
    'CEILING',
    'CHAIN',
    'CHAR',
    'CHARACTER',
    'CHARACTERISTICS',
    'CHARACTERS',
    'CHARACTER_LENGTH',
    'CHARACTER_SET_CATALOG',
    'CHARACTER_SET_NAME',
    'CHARACTER_SET_SCHEMA',
    'CHAR_LENGTH',
    'CHECK',
    'CHECKED',
    'CHECKPOINT',
    'CLASS',
    'CLASS_ORIGIN',
    'CLOB',
    'CLOSE',
    'CLUSTER',
    'COALESCE',
    'COBOL',
    'COLLATE',
    'COLLATION',
    'COLLATION_CATALOG',
    'COLLATION_NAME',
    'COLLATION_SCHEMA',
    'COLLECT',
    'COLUMN',
    'COLUMN_NAME',
    'COMMAND_FUNCTION',
    'COMMAND_FUNCTION_CODE',
    'COMMENT',
    'COMMIT',
    'COMMITTED',
    'COMPLETION',
    'CONDITION',
    'CONDITION_NUMBER',
    'CONFLICT',
    'CONNECT',
    'CONNECTION',
    'CONNECTION_NAME',
    'CONSTRAINT',
    'CONSTRAINTS',
    'CONSTRAINT_CATALOG',
    'CONSTRAINT_NAME',
    'CONSTRAINT_SCHEMA',
    'CONSTRUCTOR',
    'CONTAINS',
    'CONTINUE',
    'CONVERSION',
    'CONVERT',
    'COPY',
    'CORR',
    'CORRESPONDING',
    'COUNT',
    'COVAR_POP',
    'COVAR_SAMP',
    'CREATE',
    'CREATEDB',
    'CREATEROLE',
    'CREATEUSER',
    'CROSS',
    'CSV',
    'CUBE',
    'CUME_DIST',
    'CURRENT',
    'CURRENT_DATE',
    'CURRENT_DEFAULT_TRANSFORM_GROUP',
    'CURRENT_PATH',
    'CURRENT_ROLE',
    'CURRENT_TIME',
    'CURRENT_TIMESTAMP',
    'CURRENT_TRANSFORM_GROUP_FOR_TYPE',
    'CURRENT_USER',
    'CURSOR',
    'CURSOR_NAME',
    'CYCLE',
    'DATA',
    'DATABASE',
    'DATE',
    'DATETIME_INTERVAL_CODE',
    'DATETIME_INTERVAL_PRECISION',
    'DAY',
    'DEALLOCATE',
    'DEC',
    'DECIMAL',
    'DECLARE',
    'DEFAULT',
    'DEFAULTS',
    'DEFERRABLE',
    'DEFERRED',
    'DEFINED',
    'DEFINER',
    'DEGREE',
    'DELETE',
    'DELIMITER',
    'DELIMITERS',
    'DENSE_RANK',
    'DEPTH',
    'DEREF',
    'DERIVED',
    'DESC',
    'DESCRIBE',
    'DESCRIPTOR',
    'DESTROY',
    'DESTRUCTOR',
    'DETERMINISTIC',
    'DIAGNOSTICS',
    'DICTIONARY',
    'DISABLE',
    'DISCONNECT',
    'DISPATCH',
    'DISTINCT',
    'DO',
    'DOMAIN',
    'DOUBLE',
    'DROP',
    'DYNAMIC',
    'DYNAMIC_FUNCTION',
    'DYNAMIC_FUNCTION_CODE',
    'EACH',
    'ELEMENT',
    'ELSE',
    'ENABLE',
    'ENCODING',
    'ENCRYPTED',
    'END',
    'END',
    'EQUALS',
    'ESCAPE',
    'EVERY',
    'EXCEPT',
    'EXCEPTION',
    'EXCLUDE',
    'EXCLUDING',
    'EXCLUSIVE',
    'EXEC',
    'EXECUTE',
    'EXISTING',
    'EXISTS',
    'EXP',
    'EXPLAIN',
    'EXTERNAL',
    'EXTRACT',
    'FALSE',
    'FETCH',
    'FILTER',
    'FINAL',
    'FIRST',
    'FLOAT',
    'FLOOR',
    'FOLLOWING',
    'FOR',
    'FORCE',
    'FOREIGN',
    'FORTRAN',
    'FORWARD',
    'FOUND',
    'FREE',
    'FREEZE',
    'FROM',
    'FULL',
    'FUNCTION',
    'FUSION',
    'G',
    'GENERAL',
    'GENERATED',
    'GET',
    'GLOBAL',
    'GO',
    'GOTO',
    'GRANT',
    'GRANTED',
    'GREATEST',
    'GROUP',
    'GROUPING',
    'HANDLER',
    'HAVING',
    'HEADER',
    'HIERARCHY',
    'HOLD',
    'HOST',
    'HOUR',
    'IDENTITY',
    'IGNORE',
    'ILIKE',
    'IMMEDIATE',
    'IMMUTABLE',
    'IMPLEMENTATION',
    'IMPLICIT',
    'IN',
    'INCLUDING',
    'INCREMENT',
    'INDEX',
    'INDICATOR',
    'INFIX',
    'INHERIT',
    'INHERITS',
    'INITIALIZE',
    'INITIALLY',
    'INNER',
    'INOUT',
    'INPUT',
    'INSENSITIVE',
    'INSERT',
    'INSTANCE',
    'INSTANTIABLE',
    'INSTEAD',
    'INT',
    'INTEGER',
    'INTERSECT',
    'INTERSECTION',
    'INTERVAL',
    'INTO',
    'INVOKER',
    'IS',
    'ISNULL',
    'ISOLATION',
    'ITERATE',
    'JOIN',
    'K',
    'KEY',
    'KEY_MEMBER',
    'KEY_TYPE',
    'LANCOMPILER',
    'LANGUAGE',
    'LARGE',
    'LAST',
    'LATERAL',
    'LEADING',
    'LEAST',
    'LEFT',
    'LENGTH',
    'LESS',
    'LEVEL',
    'LIKE',
    'LIMIT',
    'LISTEN',
    'LN',
    'LOAD',
    'LOCAL',
    'LOCALTIME',
    'LOCALTIMESTAMP',
    'LOCATION',
    'LOCATOR',
    'LOCK',
    'LOGIN',
    'LOWER',
    'M',
    'MAP',
    'MATCH',
    'MATCHED',
    'MAX',
    'MAXVALUE',
    'MEMBER',
    'MERGE',
    'MESSAGE_LENGTH',
    'MESSAGE_OCTET_LENGTH',
    'MESSAGE_TEXT',
    'METHOD',
    'MIN',
    'MINUTE',
    'MINVALUE',
    'MOD',
    'MODE',
    'MODIFIES',
    'MODIFY',
    'MODULE',
    'MONTH',
    'MORE',
    'MOVE',
    'MULTISET',
    'MUMPS',
    'NAME',
    'NAMES',
    'NATIONAL',
    'NATURAL',
    'NCHAR',
    'NCLOB',
    'NESTING',
    'NEW',
    'NEXT',
    'NO',
    'NOCREATEDB',
    'NOCREATEROLE',
    'NOCREATEUSER',
    'NOINHERIT',
    'NOLOGIN',
    'NONE',
    'NORMALIZE',
    'NORMALIZED',
    'NOSUPERUSER',
    'NOT',
    'NOTHING',
    'NOTIFY',
    'NOTNULL',
    'NOWAIT',
    'NULL',
    'NULLABLE',
    'NULLIF',
    'NULLS',
    'NUMBER',
    'NUMERIC',
    'OBJECT',
    'OCTETS',
    'OCTET_LENGTH',
    'OF',
    'OFF',
    'OFFSET',
    'OIDS',
    'OLD',
    'ON',
    'ONLY',
    'OPEN',
    'OPERATION',
    'OPERATOR',
    'OPTION',
    'OPTIONS',
    'OR',
    'ORDER',
    'ORDERING',
    'ORDINALITY',
    'OTHERS',
    'OUT',
    'OUTER',
    'OUTPUT',
    'OVER',
    'OVERLAPS',
    'OVERLAY',
    'OVERRIDING',
    'OWNER',
    'PAD',
    'PARAMETER',
    'PARAMETERS',
    'PARAMETER_MODE',
    'PARAMETER_NAME',
    'PARAMETER_ORDINAL_POSITION',
    'PARAMETER_SPECIFIC_CATALOG',
    'PARAMETER_SPECIFIC_NAME',
    'PARAMETER_SPECIFIC_SCHEMA',
    'PARTIAL',
    'PARTITION',
    'PASCAL',
    'PASSWORD',
    'PATH',
    'PERCENTILE_CONT',
    'PERCENTILE_DISC',
    'PERCENT_RANK',
    'PLACING',
    'PLI',
    'POSITION',
    'POSTFIX',
    'POWER',
    'PRECEDING',
    'PRECISION',
    'PREFIX',
    'PREORDER',
    'PREPARE',
    'PREPARED',
    'PRESERVE',
    'PRIMARY',
    'PRIOR',
    'PRIVILEGES',
    'PROCEDURAL',
    'PROCEDURE',
    'PUBLIC',
    'QUOTE',
    'RANGE',
    'RANK',
    'READ',
    'READS',
    'REAL',
    'RECHECK',
    'RECURSIVE',
    'REF',
    'REFERENCES',
    'REFERENCING',
    'REGR_AVGX',
    'REGR_AVGY',
    'REGR_COUNT',
    'REGR_INTERCEPT',
    'REGR_R2',
    'REGR_SLOPE',
    'REGR_SXX',
    'REGR_SXY',
    'REGR_SYY',
    'REINDEX',
    'RELATIVE',
    'RELEASE',
    'RENAME',
    'REPEATABLE',
    'REPLACE',
    'RESET',
    'RESTART',
    'RESTRICT',
    'RESULT',
    'RETURN',
    'RETURNING',
    'RETURNED_CARDINALITY',
    'RETURNED_LENGTH',
    'RETURNED_OCTET_LENGTH',
    'RETURNED_SQLSTATE',
    'RETURNS',
    'REVOKE',
    'RIGHT',
    'ROLE',
    'ROLLBACK',
    'ROLLUP',
    'ROUTINE',
    'ROUTINE_CATALOG',
    'ROUTINE_NAME',
    'ROUTINE_SCHEMA',
    'ROW',
    'ROWS',
    'ROW_COUNT',
    'ROW_NUMBER',
    'RULE',
    'SAVEPOINT',
    'SCALE',
    'SCHEMA',
    'SCHEMA_NAME',
    'SCOPE',
    'SCOPE_CATALOG',
    'SCOPE_NAME',
    'SCOPE_SCHEMA',
    'SCROLL',
    'SEARCH',
    'SECOND',
    'SECTION',
    'SECURITY',
    'SELECT',
    'SELF',
    'SENSITIVE',
    'SEQUENCE',
    'SERIALIZABLE',
    'SERVER_NAME',
    'SESSION',
    'SESSION_USER',
    'SET',
    'SETOF',
    'SETS',
    'SHARE',
    'SHOW',
    'SIMILAR',
    'SIMPLE',
    'SIZE',
    'SMALLINT',
    'SOME',
    'SOURCE',
    'SPACE',
    'SPECIFIC',
    'SPECIFICTYPE',
    'SPECIFIC_NAME',
    'SQL',
    'SQLCODE',
    'SQLERROR',
    'SQLEXCEPTION',
    'SQLSTATE',
    'SQLWARNING',
    'SQRT',
    'STABLE',
    'START',
    'STATE',
    'STATEMENT',
    'STATIC',
    'STATISTICS',
    'STDDEV_POP',
    'STDDEV_SAMP',
    'STDIN',
    'STDOUT',
    'STORAGE',
    'STRICT',
    'STRUCTURE',
    'STYLE',
    'SUBCLASS_ORIGIN',
    'SUBLIST',
    'SUBMULTISET',
    'SUBSTRING',
    'SUM',
    'SUPERUSER',
    'SYMMETRIC',
    'SYSID',
    'SYSTEM',
    'SYSTEM_USER',
    'TABLE',
    'TABLESAMPLE',
    'TABLESPACE',
    'TABLE_NAME',
    'TEMP',
    'TEMPLATE',
    'TEMPORARY',
    'TERMINATE',
    'THAN',
    'THEN',
    'TIES',
    'TIME',
    'TIMESTAMP',
    'TIMEZONE_HOUR',
    'TIMEZONE_MINUTE',
    'TO',
    'TOAST',
    'TOP_LEVEL_COUNT',
    'TRAILING',
    'TRANSACTION',
    'TRANSACTIONS_COMMITTED',
    'TRANSACTIONS_ROLLED_BACK',
    'TRANSACTION_ACTIVE',
    'TRANSFORM',
    'TRANSFORMS',
    'TRANSLATE',
    'TRANSLATION',
    'TREAT',
    'TRIGGER',
    'TRIGGER_CATALOG',
    'TRIGGER_NAME',
    'TRIGGER_SCHEMA',
    'TRIM',
    'TRUE',
    'TRUNCATE',
    'TRUSTED',
    'TYPE',
    'UESCAPE',
    'UNBOUNDED',
    'UNCOMMITTED',
    'UNDER',
    'UNENCRYPTED',
    'UNION',
    'UNIQUE',
    'UNKNOWN',
    'UNLISTEN',
    'UNNAMED',
    'UNNEST',
    'UNTIL',
    'UPDATE',
    'UPPER',
    'USAGE',
    'USER',
    'USER_DEFINED_TYPE_CATALOG',
    'USER_DEFINED_TYPE_CODE',
    'USER_DEFINED_TYPE_NAME',
    'USER_DEFINED_TYPE_SCHEMA',
    'USING',
    'VACUUM',
    'VALID',
    'VALIDATOR',
    'VALUE',
    'VALUES',
    'VARCHAR',
    'VARIABLE',
    'VARYING',
    'VAR_POP',
    'VAR_SAMP',
    'VERBOSE',
    'VIEW',
    'VOLATILE',
    'WHEN',
    'WHENEVER',
    'WHERE',
    'WIDTH_BUCKET',
    'WINDOW',
    'WITH',
    'WITHIN',
    'WITHOUT',
    'WORK',
    'WRITE',
    'YEAR',
    'ZONE',
];

const minorKeywords = [
    'AS',
    'ASC',
    'DESC',
    'IS',
    'NOT',
    'NOTNULL',
    'NULL',
];
