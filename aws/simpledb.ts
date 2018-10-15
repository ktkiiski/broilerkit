import { SimpleDB } from 'aws-sdk';
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

    public async *select(query: string, consistent: boolean): AsyncIterableIterator<Item[]> {
        let params: SimpleDB.SelectRequest = {
            SelectExpression: query,
            ConsistentRead: consistent,
        };
        while (true) {
            const {Items = [], NextToken} = await this.simpleDB.select(params).promise();
            yield Items.map((item) => ({
                name: item.Name,
                attributes: buildObject(item.Attributes, ({Name, Value}) => [Name, Value]),
            }));
            if (!NextToken) {
                break;
            }
            params = {...params, NextToken};
        }
    }

    public async putAttributes(params: SimpleDB.PutAttributesRequest): Promise<{}> {
        return await this.simpleDB.putAttributes(params).promise();
    }

    public async deleteAttributes(params: SimpleDB.DeleteAttributesRequest): Promise<{}> {
        return await this.simpleDB.deleteAttributes(params).promise();
    }
}

export function escapeQueryParam(param: string): string {
    return `'${param.replace(/'/g, `''`)}'`;
}

export function escapeQueryIdentifier(param: string): string {
    return `\`${param.replace(/`/g, '``')}\``;
}
