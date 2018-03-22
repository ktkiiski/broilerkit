import { SimpleDB } from 'aws-sdk';
import map = require('lodash/map');
import { buildObject } from '../utils/objects';

export interface ItemAttributes {
    [key: string]: string;
}

export interface Item {
    name: string;
    attributes: ItemAttributes;
}

export class AmazonSimpleDB {

    private simpleDB = new SimpleDB({
        region: this.region,
        apiVersion: '2009-04-15',
    });

    constructor(private region: string) { }

    public async getAttributes<T extends ItemAttributes>(params: SimpleDB.GetAttributesRequest): Promise<T> {
        const result = await this.simpleDB.getAttributes(params).promise();
        return buildObject(result.Attributes || [], ({Name, Value}) => [Name, Value]) as T;
    }

    public async selectNext(query: string, consistent: boolean): Promise<Item[]> {
        const request = this.simpleDB.select({
            SelectExpression: query,
            ConsistentRead: consistent,
        });
        const response = await request.promise();
        return map(
            response.Items,
            (item) => ({
                name: item.Name,
                attributes: buildObject(item.Attributes, ({Name, Value}) => [Name, Value]),
            }),
        );
    }

    public async putAttributes(params: SimpleDB.PutAttributesRequest): Promise<{}> {
        return await this.simpleDB.putAttributes(params).promise();
    }

    public async deleteAttributes(params: SimpleDB.DeleteAttributesRequest): Promise<{}> {
        return await this.simpleDB.deleteAttributes(params).promise();
    }
}

export function escapeQueryParam(param: string): string {
    return `'${param.replace(`'`, `''`)}'`;
}

export function escapeQueryIdentifier(param: string): string {
    return `\`${param.replace('`', '``')}\``;
}
