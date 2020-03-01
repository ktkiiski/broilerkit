import * as assert from 'assert';
import 'mocha';
import { datetime, list, number, string } from '../fields';
import { FieldSerializer, nested, nestedList } from '../serializers';

describe('serializer', () => {
    const SubItem = new FieldSerializer({
        id: string(),
        title: string(),
    });
    const Item = new FieldSerializer({
        name: string(),
        index: number(),
        tags: list(string()),
        createdAt: datetime(),
        nested: nested(SubItem),
        nestedList: nestedList(SubItem),
    });
    const now = new Date();
    const item = {
        name: 'Hello',
        index: 123,
        tags: ['foo', 'bar'],
        createdAt: now,
        nested: {
            id: 'e123',
            title: 'Example',
        },
        nestedList: [{
            id: 'e1',
            title: 'Example 1',
        }, {
            id: 'e2',
            title: 'Example 2',
        }],
    };
    describe('pack()', () => {
        it('packs an object', () => {
            assert.deepEqual(
                Item.pack(item),
                ['Hello', 123, ['foo', 'bar'], now.toISOString(), ['e123', 'Example'], [['e1', 'Example 1'], ['e2', 'Example 2']]],
            );
        });
        it('packs an partial object', () => {
            assert.deepEqual(
                Item.fullPartial().pack({
                    name: 'Hello',
                    nested: {
                        id: 'e123',
                        title: 'Example',
                    },
                    nestedList: [{
                        id: 'e1',
                        title: 'Example 1',
                    }, {
                        id: 'e2',
                        title: 'Example 2',
                    }],
                }),
                {
                    name: 'Hello',
                    nested: ['e123', 'Example'],
                    nestedList: [['e1', 'Example 1'], ['e2', 'Example 2']],
                },
            );
        });
    });
    describe('pack()', () => {
        it('packs an object', () => {
            assert.deepEqual(
                Item.unpack(['Hello', 123, ['foo', 'bar'], now.toISOString(), ['e123', 'Example'], [['e1', 'Example 1'], ['e2', 'Example 2']]]),
                item,
            );
        });
        it('unpacks an partial object', () => {
            assert.deepEqual(
                Item.fullPartial().unpack({
                    name: 'Hello',
                    nested: ['e123', 'Example'],
                    nestedList: [['e1', 'Example 1'], ['e2', 'Example 2']],
                }),
                {
                    name: 'Hello',
                    nested: {
                        id: 'e123',
                        title: 'Example',
                    },
                    nestedList: [{
                        id: 'e1',
                        title: 'Example 1',
                    }, {
                        id: 'e2',
                        title: 'Example 2',
                    }],
                },
            );
        });
    });
});
