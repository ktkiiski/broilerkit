import hasOwnProperty from 'immuton/hasOwnProperty';
import type { ParameterConfig } from './index';
import { bold } from './palette';
import { readAnswer } from './readline';

interface ParameterConfigs {
    [param: string]: ParameterConfig;
}
interface Parameters<T> {
    [param: string]: string | T;
}

export async function askParameters<T = never>(
    parameters: ParameterConfigs | undefined,
    prevParams?: Parameters<T>,
    prefix = '',
): Promise<Parameters<T>> {
    const customParameters: { [param: string]: string | T } = {};
    if (parameters) {
        // eslint-disable-next-line no-restricted-syntax
        for (const key in parameters) {
            if (hasOwnProperty(parameters, key)) {
                const paramName = `${prefix}${key}`;
                const { description } = parameters[key];
                let value = prevParams && prevParams[paramName];
                if (value === undefined) {
                    value = await readAnswer(
                        `The app requires the following configuration parameter: ${bold(description)}\n` +
                            `Please enter the value:`,
                    );
                    if (!value) {
                        throw new Error(`Missing configuration parameter!`);
                    }
                }
                customParameters[paramName] = value;
            }
        }
    }
    return customParameters;
}
