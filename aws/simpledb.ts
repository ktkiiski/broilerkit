import { SimpleDB } from 'aws-sdk';
import build from 'immuton/build';

interface ItemAttributes {
    [key: string]: string;
}

interface Item {
    name: string;
    attributes: ItemAttributes;
}

interface ItemChunk {
    items: Item[];
    isComplete: boolean;
}

export class AmazonSimpleDB {

    private simpleDB = new SimpleDB({
        region: this.region,
        apiVersion: '2009-04-15',
        maxRetries: 20,
    });

    constructor(private region: string) { }

    public async getAttributes<T extends ItemAttributes>(params: SimpleDB.GetAttributesRequest): Promise<T> {
        const result = await this.simpleDB.getAttributes(params).promise();
        return build(result.Attributes || [], ({Name, Value}) => [Name, Value]) as T;
    }

    public async *select(query: string, consistent: boolean): AsyncIterableIterator<ItemChunk> {
        let params: SimpleDB.SelectRequest = {
            SelectExpression: query,
            ConsistentRead: consistent,
        };
        while (true) {
            const {Items = [], NextToken} = await this.simpleDB.select(params).promise();
            const items = Items.map((item) => ({
                name: item.Name,
                attributes: build(item.Attributes, ({Name, Value}) => [Name, Value]),
            }));
            yield { items, isComplete: !NextToken };
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
