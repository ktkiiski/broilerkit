import isNotNully from 'immuton/isNotNully';
import isNully from 'immuton/isNully';
import { Key } from 'immuton/types';
import { keys } from './objects';
import { cyan, dim, magenta, red } from './palette';
import { Resource } from './resources';
import { Fields, Serializer } from './serializers';

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

interface InsertResult<R> {
    item: R;
    wasCreated: boolean;
}

export interface TableDefaults {
    [name: string]: {[key: string]: any};
}

export function selectQuery<S>(
    resource: Resource<S, any, any>,
    defaultsByTable: TableDefaults,
    filters: Record<string, any>,
    limit?: number,
    ordering?: string,
    direction?: 'asc' | 'desc',
    since?: any,
): SqlQuery<S[]> {
    const params: any[] = [];
    const { name } = resource;
    let sql = `SELECT ${getSelectColumnsSql(resource, params, defaultsByTable)} FROM ${ref(name)}`;
    sql += getJoinSql(name, resource, params, defaultsByTable);
    const filtersSql = filterConditionSql(filters, resource, params, defaultsByTable);
    const conditions = filtersSql ? [filtersSql] : [];
    if (ordering && direction && since != null) {
        const dirOp = direction === 'asc' ? '>' : '<';
        conditions.push(`${ref(name)}.${ref(ordering)} ${dirOp} ${param(params, since)}`);
    }
    if (conditions.length) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    if (ordering && direction) {
        sql += ` ORDER BY ${ref(name)}.${ref(ordering)} ${direction.toUpperCase()}`;
    }
    if (limit != null) {
        sql += ` LIMIT ${param(params, limit)}`;
    }
    sql += ';';
    return makeQuery(sql, params, ({ rows }) => (
        rows.map((row) => parseRow(name, resource, row)).filter(isNotNully)
    ));
}

export function batchSelectQuery<S>(
    resource: Resource<S, any, any>,
    defaultsByTable: TableDefaults,
    filtersList: Array<Record<string, any>>,
): SqlQuery<S[]> {
    const { name, columns } = resource;
    const params: any[] = [];
    // TODO: Joins!
    let sql = `SELECT ${returnColumnsSql(name, columns, params, defaultsByTable[name])} FROM ${ref(name)}`;
    const orConditions = filtersList.map((filters) => (
        `(${filterConditionSql(filters, resource, params, defaultsByTable)})`
    ));
    sql += ` WHERE ${orConditions.join(' OR ')};`;
    return makeQuery(sql, params, ({ rows }) => (
        rows.map((row) => parseRow(name, resource, row)).filter(isNotNully)
    ));
}

export function updateQuery<S>(
    resource: Resource<S, any, any>,
    filters: Record<string, any>,
    values: Record<string, any>,
    defaultsByTable: TableDefaults,
    returnPrevious: false,
): SqlQuery<S[]>;
export function updateQuery<S>(
    resource: Resource<S, any, any>,
    filters: Record<string, any>,
    values: Record<string, any>,
    defaultsByTable: TableDefaults,
    returnPrevious: true,
): SqlQuery<Array<[S, S]>>;
export function updateQuery<S>(
    resource: Resource<S, any, any>,
    filters: Record<string, any>,
    values: Record<string, any>,
    defaultsByTable: TableDefaults,
    returnPrevious?: boolean,
): SqlQuery<S[] | Array<[S, S]>>;
export function updateQuery<S>(
    resource: Resource<S, any, any>,
    filters: Record<string, any>,
    values: Record<string, any>,
    defaultsByTable: TableDefaults,
    returnPrevious: boolean = false,
): SqlQuery<S[] | Array<[S, S]>> {
    const params: any[] = [];
    const assignments: string[] = [];
    const { name, columns, identifyBy } = resource;
    keys(columns).forEach((key) => {
        const value = values[key];
        if (typeof value !== 'undefined' && !identifyBy.includes(key as Key<S>)) {
            assignments.push(assignmentSql(name, key, value, params));
        }
    });
    const defaults = defaultsByTable[name];
    const tblRef = ref(name);
    const valSql = assignments.join(', ');
    const condSql = filterConditionSql(filters, resource, params, defaults);
    const returnSql = returnColumnsSql(name, columns, params, defaults);
    if (returnPrevious) {
        // Join the current state to the query in order to return the previous state
        const columnSql = keys(columns).map(ref).join(', ');
        // NOTE: As we assume SERIALIZABLE transactions, we don't need `FOR UPDATE`
        const prevSelect = `SELECT ${columnSql} FROM ${tblRef} WHERE ${condSql}`;
        const prevAlias = '_previous';
        const prevRef = ref(prevAlias);
        const joinConditions = identifyBy.map((pk) => (
            `${prevRef}.${ref(pk)} = ${tblRef}.${ref(pk)}`
        ));
        const joinSql = joinConditions.join(' AND ');
        const prevReturnSql = returnColumnsSql(prevAlias, columns, params, defaults);
        const sql = `UPDATE ${tblRef} SET ${valSql} FROM (${prevSelect}) ${prevRef} WHERE ${joinSql} RETURNING ${prevReturnSql}, ${returnSql};`;
        return makeQuery(sql, params, ({ rows }) => (
            rows.map((row) => {
                const newItem = parseRow(name, resource, row);
                const oldItem = parseRow('_previous', resource, row);
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
            rows.map((row) => parseRow(name, resource, row)).filter(isNotNully)
        ));
    }
}

export function insertQuery<S>(
    resource: Resource<S, any, any>,
    defaultsByTable: TableDefaults,
    insertValues: Record<string, any>,
    updateValues: Record<string, any>,
): SqlQuery<InsertResult<S>>;
export function insertQuery<S>(
    resource: Resource<S, any, any>,
    defaultsByTable: TableDefaults,
    insertValues: Record<string, any>,
    updateValues?: Record<string, any>,
): SqlQuery<InsertResult<S> | null>;
export function insertQuery<S>(
    resource: Resource<S, any, any>,
    defaultsByTable: TableDefaults,
    insertValues: Record<string, any>,
    updateValues?: Record<string, any>,
): SqlQuery<InsertResult<S> | null> {
    const params: any[] = [];
    const columnNames: string[] = [];
    const placeholders: string[] = [];
    const updates: string[] = [];
    const { name, columns, identifyBy } = resource;
    const defaults = defaultsByTable[name];
    keys(columns).forEach((key) => {
        columnNames.push(ref(key));
        placeholders.push(param(params, insertValues[key]));
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
        const pkSql = identifyBy.map(ref).join(',');
        const upSql = updates.join(', ');
        sql += ` ON CONFLICT (${pkSql}) DO UPDATE SET ${upSql}`;
    } else {
        sql += ` ON CONFLICT DO NOTHING`;
    }
    sql += ` RETURNING ${returnColumnsSql(name, columns, params, defaults)}, xmax::text::int;`;
    return makeQuery(sql, params, ({ rows }) => {
        for (const { xmax, ...row } of rows) {
            const item = parseRow(name, resource, row);
            if (item) {
                return { item, wasCreated: xmax === 0 };
            }
        }
        return null;
    });
}

export function deleteQuery<S>(
    resource: Resource<S, any, any>,
    filters: Record<string, any>,
    defaultsByTable: TableDefaults,
): SqlQuery<S | null> {
    const params: any[] = [];
    const { name, columns } = resource;
    const defaults = defaultsByTable[name];
    let sql = `DELETE FROM ${ref(name)}`;
    const conditionSql = filterConditionSql(filters, resource, params, defaults);
    if (conditionSql) {
        sql += ` WHERE ${conditionSql}`;
    }
    sql += ` RETURNING ${returnColumnsSql(name, columns, params, defaults)};`;
    return {
        sql, params,
        deserialize({ rows }) {
            if (!rows.length) {
                return null;
            }
            return parseRow(name, resource, rows[0]);
        },
    };
}

export function countQuery(
    resource: Resource<any, any, any>,
    filters: Record<string, any>,
    defaultsByTable: TableDefaults,
): SqlQuery<number> {
    const params: any[] = [];
    const { name } = resource;
    const defaults = defaultsByTable[name];
    let sql = `SELECT COUNT(*)::int AS count FROM ${ref(name)}`;
    const filtersSql = filterConditionSql(filters, resource, params, defaults);
    if (filtersSql) {
        sql += ` WHERE ${filtersSql}`;
    }
    sql += ';';
    return makeQuery(sql, params, ({ rows }) => rows[0]?.count ?? 0);
}

export class Increment {
    constructor(public readonly diff: number) {}
}

export function increment(diff: number) {
    return new Increment(diff);
}

function getSelectColumnsSql(resource: Resource<any, any, any>, params: any[], defaultsByTable: TableDefaults, name = resource.name): string {
    const { nestings, columns } = resource;
    const selectSqls = [
        returnColumnsSql(name, columns, params, defaultsByTable[resource.name]),
    ];
    // Regular joins
    resource.joins.forEach((join, index) => {
        const defaults = defaultsByTable[join.resource.name] || {};
        const joinName = `${name}._join${index}`;
        for (const columnName of Object.keys(join.fields)) {
            const sourceName = join.fields[columnName];
            const defaultValue = join.type === 'left' ? join.defaults[columnName] : undefined;
            selectSqls.push(selectColumn(
                joinName, sourceName, `${name}.${columnName}`,
                typeof defaultValue === 'undefined' ? defaults[sourceName] : defaultValue,
                params,
            ));
        }
    });
    // Nesting joins
    Object.keys(nestings).forEach((key) => {
        const nesting = nestings[key];
        selectSqls.push(getSelectColumnsSql(nesting.resource, params, defaultsByTable, `${name}.${key}`));
    });
    return selectSqls.join(', ');
}

function getJoinSql(baseName: string, resource: Resource<any, any, any>, params: any[], defaultsByTable: TableDefaults): string {
    const joinSqlCmps: string[] = [];
    const { joins } = resource;
    // Regular inner joins
    joins.forEach((join, index) => {
        const { on, type } = join;
        const joinResourceName = join.resource.name;
        const defaults = defaultsByTable[joinResourceName];
        const joinName = `${baseName}._join${index}`;
        const joinConditions: string[] = [];
        Object.keys(on).forEach((targetKey) => {
            const onCond = on[targetKey];
            if (typeof onCond === 'string') {
                if (resource.columns[onCond]) {
                    joinConditions.push(
                        `${ref(joinName)}.${ref(targetKey)} = ${ref(baseName)}.${ref(onCond)}`,
                    );
                } else {
                    joins.slice(0, index).forEach((prevJoin, prevIndex) => {
                        const prevJoinName = `${baseName}._join${prevIndex}`;
                        const source = prevJoin.fields[onCond];
                        if (source != null) {
                            joinConditions.push(
                                `${ref(joinName)}.${ref(targetKey)} = ${ref(prevJoinName)}.${ref(source)}`,
                            );
                        }
                    });
                }
            } else {
                const defaultValue = defaults && defaults[targetKey];
                joinConditions.push(
                    filterSql(joinName, targetKey, onCond.value, params, defaultValue),
                );
            }
        });
        const onSql = joinConditions.join(' AND ');
        const joinOp = type === 'left' ? 'LEFT JOIN' : 'INNER JOIN';
        joinSqlCmps.push(` ${joinOp} ${ref(joinResourceName)} AS ${ref(joinName)} ON ${onSql}`);
        joinSqlCmps.push(getJoinSql(joinName, join.resource, params, defaultsByTable));
    });
    // Nesting joins
    Object.keys(resource.nestings).forEach((key) => {
        const nesting = resource.nestings[key];
        const joinName = `${baseName}.${key}`;
        const joinConditions: string[] = [];
        Object.keys(nesting.on).forEach((targetKey) => {
            for (const [sourceTable, sourceKey] of resolveColumnRefs(baseName, nesting.on[targetKey], resource)) {
                joinConditions.push(
                    `${ref(joinName)}.${ref(targetKey)} = ${ref(sourceTable)}.${ref(sourceKey)}`,
                );
            }
        });
        const onSql = joinConditions.join(' AND ');
        joinSqlCmps.push(` LEFT JOIN ${ref(nesting.resource.name)} AS ${ref(joinName)} ON ${onSql}`);
        joinSqlCmps.push(getJoinSql(joinName, nesting.resource, params, defaultsByTable));
    });
    return joinSqlCmps.join('');
}

function assignmentSql(tableName: string, field: string, value: any, params: any[]): string {
    if (value instanceof Increment) {
        // Make an increment statement
        return `${ref(field)} = COALESCE(${ref(tableName)}.${ref(field)}, 0) + ${param(params, value.diff)}`;
    }
    return `${ref(field)} = ${param(params, value)}`;
}

function filterSql(tableName: string, field: string, value: any, params: any[], defaultValue: any): string {
    const colRef = ref(tableName) + '.' + ref(field);
    if (value == null) {
        if (defaultValue != null) {
            // The value would be migrated to a non-null value, so it cannot be NULL!
            return 'FALSE';
        }
        return `${colRef} IS NULL`;
    }
    if (!Array.isArray(value)) {
        if (defaultValue === value) {
            // Comparing to the default value, therefore NULL is also accepted
            return `(${colRef} = ${param(params, value)} OR ${colRef} IS NULL)`;
        }
        // Normal equality comparison
        return `${colRef} = ${param(params, value)}`;
    }
    // Build an IN condition
    if (!value.length) {
        // would result in `xxxx IN ()` which won't work
        return `FALSE`;
    }
    if (value.some(isNully) || value.some((val) => val === defaultValue)) {
        // NULL is one of the valid options, so need a separate IS NULL condition.
        const nonNullValues = value.filter(isNotNully);
        if (!nonNullValues.length) {
            return `${colRef} IS NULL`;
        }
        // Get the actual condition recursively.
        const condition = filterSql(tableName, field, nonNullValues, params, undefined);
        return `(${condition} OR ${colRef} IS NULL)`;
    }
    const placeholders = value.map((item) => {
        return param(params, item);
    });
    return `${colRef} IN (${placeholders.join(',')})`;
}

function resolveColumnRefs(baseName: string, columnName: string, resource: Resource<any, any, any>): Array<[string, string]> {
    const refs: Array<[string, string]> = [];
    resource.joins.forEach((join, index) => {
        if (join.type === 'left') {
            return;
        }
        const joinName = `${baseName}._join${index}`;
        const source = join.fields[columnName];
        if (source != null) {
            refs.push([joinName, source]);
        }
        Object.keys(join.on).forEach((targetKey) => {
            const sourceKey = join.on[targetKey];
            if (sourceKey === columnName && !refs.some(([x, y]) => x === joinName && y === targetKey)) {
                refs.push([joinName, targetKey]);
            }
        });
    });
    if (resource.columns[columnName]) {
        refs.push([baseName, columnName]);
    }
    if (refs.length) {
        return refs;
    }
    throw new Error(`Unknown column "${columnName}"`);
}

function filterConditionSql(filters: {[field: string]: any}, resource: Resource<any, any, any>, params: any[], defaults: {[key: string]: any}): string {
    const conditions: string[] = [];
    keys(filters).map((field) => {
        const value = filters[field];
        if (typeof value !== 'undefined') {
            for (const [tableName, column] of resolveColumnRefs(resource.name, field, resource)) {
                const defaultValue = defaults && defaults[column];
                conditions.push(filterSql(tableName, column, filters[field], params, defaultValue));
            }
        }
    });
    return conditions.join(' AND ');
}

function selectColumn(tableName: string, columnName: string, alias: string, defaultValue: any, params: any[]) {
    if (typeof defaultValue === 'undefined') {
        return `${ref(tableName)}.${ref(columnName)} AS ${ref(alias)}`;
    }
    return `COALESCE(${ref(tableName)}.${ref(columnName)}, ${param(params, defaultValue)}) AS ${ref(alias)}`;
}

function returnColumnsSql(tableName: string, columns: Fields<any>, params: any[], defaults: {[key: string]: any}): string {
    const columnSqls = keys(columns).map((column) => {
        const defaultValue = defaults && defaults[column];
        return selectColumn(tableName, column, `${tableName}.${column}`, defaultValue, params);
    });
    return columnSqls.join(', ');
}

function param(params: any[], value: any): string {
    params.push(value);
    return `$${params.length}`;
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
        return value < 0 ? `(${str})` : str;
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

function parseRow<S>(
    tableAlias: string,
    resource: Serializer<S>,
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
    const result = cleanupNullNestings(item);
    if (result == null) {
        return null;
    }
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
        if (dangerKeywords.includes(token)) {
            return red(token);
        }
        if (minorKeywords.includes(token)) {
            return dim(keywordColor(token));
        }
        if (keywords.includes(token)) {
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
    'CONCURRENTLY',
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
    'IF',
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

const dangerKeywords = [
    'ROLLBACK',
];

const minorKeywords = [
    'AS',
    'ASC',
    'BEGIN',
    'COALESCE',
    'COMMIT',
    'DESC',
    'EXISTS',
    'IF',
    'IS',
    'ISOLATION',
    'LEVEL',
    'NOT',
    'NOTNULL',
    'NULL',
    'RELEASE',
    'SAVEPOINT',
    'SERIALIZABLE',
    'TO',
    'TRANSACTION',
];
