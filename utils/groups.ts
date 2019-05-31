export function groupBy<K extends string, T>(values: T[], selector: (item: T) => K): {[key in K]: T[]} {
    const results: {[key: string]: T[]} = {};
    for (const value of values) {
        const key = selector(value);
        const acc = results[key] = results[key] || [] as T[];
        acc.push(value);
    }
    return results as {[key in K]: T[]};
}

export function groupByAsMap<K extends string, T>(values: T[], selector: (item: T) => K): Map<K, T[]> {
    const results = new Map<K, T[]>();
    for (const value of values) {
        const key = selector(value);
        const acc = results.get(key) || [] as T[];
        results.set(key, acc);
        acc.push(value);
    }
    return results;
}
