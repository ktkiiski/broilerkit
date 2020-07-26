/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from 'path';
import * as YAML from 'yamljs';
import { readFile } from './fs';
import { forEachKey } from './objects';

export async function readTemplate(
    templateFile: string,
    placeholders: { [placeholder: string]: string } = {},
): Promise<any> {
    const templateFilePath = path.resolve(__dirname, './res/', templateFile);
    const templateStr = await readFile(templateFilePath);
    return deserializeTemplate(templateStr, placeholders);
}

export async function readTemplates(
    templateFiles: string[],
    placeholders: { [placeholder: string]: string } = {},
): Promise<any> {
    const templates = await Promise.all(templateFiles.map((templateFile) => readTemplate(templateFile, placeholders)));
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
        const result = { ...template1 };
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

async function evaluateTemplateIncludes(template: string): Promise<string> {
    const parts = template.split(/\s+!Include "([^"]+?)"/g);
    // Every 2nd item is a filename, starting at index 1
    for (let i = 1; i < parts.length; i += 2) {
        const includedFileName = parts[i];
        const includedFilePath = path.resolve(__dirname, './res/', includedFileName);
        const includedContents = await readFile(includedFilePath);
        parts[i] = ` ${JSON.stringify(includedContents)}`;
    }
    return parts.join('');
}

async function deserializeTemplate(template: string, placeholderValues: { [placeholder: string]: string }) {
    const replacedTemplate = template.replace(/<(\w+)>/g, (match, key) => {
        const value = placeholderValues[key];
        if (value == null) {
            throw new Error(`Missing template placeholder value for ${match}`);
        }
        return value;
    });
    const evaluatedTemplate = await evaluateTemplateIncludes(replacedTemplate);
    return YAML.parse(evaluatedTemplate);
}

function isArray(value: any): value is any[] {
    return Array.isArray(value);
}

function isObject(value: any): value is { [key: string]: any } {
    return !!value && typeof value === 'object' && !isArray(value);
}
