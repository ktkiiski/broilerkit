import { isArray, mergeWith } from 'lodash';
import { readFile } from './utils/fs';

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
    return mergeWith({}, template1, template2, (objValue, srcValue) => {
        if (isArray(objValue) && isArray(srcValue)) {
            return objValue.concat(srcValue);
        }
    });
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
