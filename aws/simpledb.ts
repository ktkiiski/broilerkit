import { SimpleDB } from 'aws-sdk';
import fromPairs = require('lodash/fromPairs');
import map = require('lodash/map');
import { Observable } from 'rxjs/Observable';
import { sendRequest$ } from './utils';

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

    public getAttributes<T extends ItemAttributes>(params: SimpleDB.GetAttributesRequest): Observable<T> {
        return sendRequest$(this.simpleDB.getAttributes(params))
            .map((result) => fromPairs(
                map(result.Attributes, ({Name, Value}) => [Name, Value]),
            ) as T)
        ;
    }

    public selectNext(query: string, consistent: boolean): Observable<Item[]> {
        return sendRequest$(this.simpleDB.select({
            SelectExpression: query,
            ConsistentRead: consistent,
        }))
        .map((response) => map(
            response.Items,
            (item) => ({
                name: item.Name,
                attributes: fromPairs(
                    map(item.Attributes, ({Name, Value}) => [Name, Value]),
                ),
            }),
        ));
    }

    public putAttributes(params: SimpleDB.PutAttributesRequest): Observable<{}> {
        return sendRequest$(this.simpleDB.putAttributes(params));
    }

    public deleteAttributes(params: SimpleDB.DeleteAttributesRequest): Observable<{}> {
        return sendRequest$(this.simpleDB.deleteAttributes(params));
    }
}

export function escapeQueryParam(param: string): string {
    return `'${param.replace(`'`, `''`)}'`;
}

export function escapeQueryIdentifier(param: string): string {
    return `\`${param.replace('`', '``')}\``;
}
