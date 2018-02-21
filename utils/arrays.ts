export function flatMap<T, R>(items: T[], callback: (item: T) => R[]): R[] {
    const results: R[] = [];
    for (const item of items) {
        results.push(...callback(item));
    }
    return results;
}
