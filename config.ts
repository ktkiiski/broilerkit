import { IApiDefinition } from './api';
import { ApiRequestHandler, IApiEndpoint } from './endpoints';
import { HttpMethod } from './http';

export interface IAppConfigOptions {
    appConfigPath: string;
    stage: string;
    debug: boolean;
}

export interface IAppApiEndpointConfig<T> extends IApiDefinition<T> {
    methods: HttpMethod[];
}

export interface IAppConfig extends IAppConfigOptions {
    name: string;
    broilerKitVersion: string;
    assetsOrigin: string;
    apiOrigin: string;
    buildDir: string;
    debug: boolean;
    iconFile: string;
    pages: Array<{
        title: string;
        file: string;
        scripts: string[];
    }>;
    projectRoot: string;
    region: string;
    siteOrigin: string;
    sourceDir: string;
    stackName: string;
    apiPath?: string;
    api?: ApiRequestHandler<{[endpoint: string]: IApiEndpoint<any>}>;
}
