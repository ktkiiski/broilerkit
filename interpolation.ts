/**
 * Creates a simple templater function for filling the placeholders.
 * This is intended to be used as a literal template tag:
 *
 *      const interpolate = tmpl `Hi, ${'name'}!`;
 *      const str = interpolate({name: 'John'});
 *      console.log(str);
 *
 * The example above would print "Hi, John!"
 */
export function tmpl<T extends string = never>(
    strings: TemplateStringsArray,
    ...placeholders: T[]
): (values: Record<T, string | number>) => string {
    function interpolate(values: Record<T, string | number>) {
        const chunks = strings.slice();
        placeholders.forEach((placeholder, index) => {
            const value = values[placeholder];
            chunks.splice(1 + index * 2, 0, String(value));
        });
        return chunks.join('');
    }
    return interpolate;
}
