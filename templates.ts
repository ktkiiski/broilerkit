import { readFile } from './utils/fs';
import { forEachKey, spread } from './utils/objects';

import * as path from 'path';
import * as YAML from 'yamljs';

export async function readTemplates(templateFiles: string[], placeholders: {[placeholder: string]: string} = {}) {
    const promises = templateFiles.map((templateFile) => readFile(path.resolve(__dirname, './res/', templateFile)));
    const templates: any[] = [];
    for (const promise of promises) {
        const templateStr = await promise;
        const template = deserializeTemplate(templateStr, placeholders);
        templates.push(template);
    }
    return templates.reduce(mergeTemplates, {});
}

export function mergeTemplates(template1: any, template2: any): any {
    // If the first parameter is undefined, then always return the second one.
    if (template1 === undefined) {
        return template2;
    }
    // Any two arrays in the same object keys are concatenated together
    if (isArray(template1) && isArray(template2)) {
        return template1.concat(template2);
    }
    // Any two objects are merged recursively
    if (isObject(template1) && isObject(template2)) {
        const result = spread(template1);
        forEachKey(template2, (key, value) => {
            result[key] = mergeTemplates(result[key], value);
        });
        return result;
    }
    // If parameters are the same type, then the second one overwrites the first one
    if (typeof template1 === typeof template2) {
        return template2;
    }
    // Any other situation means an error
    throw new Error(`Cannot merge incompatible template items: ${template1} & ${template2}`);
}

export function dumpTemplate(template: any): string {
    return YAML.stringify(template, 8, 2);
}

function deserializeTemplate(template: string, placeholderValues: {[placeholder: string]: string}) {
    const replacedTemplate = template.replace(/<(\w+)>/g, (match, key) => {
        const value = placeholderValues[key];
        if (value == null) {
            throw new Error(`Missing template placeholder value for ${match}`);
        }
        return value;
    });
    return YAML.parse(replacedTemplate);
}

function isArray(value: any): value is any[] {
    return Array.isArray(value);
}

function isObject(value: any): value is {[key: string]: any} {
    return !!value && typeof value === 'object' && !isArray(value);
}
