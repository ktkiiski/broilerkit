import { isArray, map, mergeWith } from 'lodash';
import { Observable } from 'rxjs';
import { readFile$ } from './utils/fs';

import * as path from 'path';
import * as YAML from 'yamljs';

export function readTemplate$(templateFiles: string[], placeholders: {[placeholder: string]: string} = {}) {
    return Observable
        .forkJoin(
            map(templateFiles, (templateFile) => readFile$(path.resolve(__dirname, './res/', templateFile))),
        )
        .concatMap((templates) => map(templates, (template) => deserializeTemplate(template, placeholders)))
        .reduce(mergeTemplates, {} as any)
    ;
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
