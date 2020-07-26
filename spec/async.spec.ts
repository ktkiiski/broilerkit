/* eslint-disable func-names */
import * as assert from 'assert';
import { asap, deferred, flatMapAsyncParallel, toArray, toAsync, wait } from '../async';

describe('flatMapAsyncParallel', () => {
    it('yields all the results (smaller than max currency)', async () => {
        const results = flatMapAsyncParallel(3, toAsync(['A', 'B']), async function* (item, index) {
            yield `${item}${index}+`;
            await asap();
            yield `${item}${index}-`;
        });
        await assertIterable(results, ['A0+', 'A0-', 'B1+', 'B1-']);
    });
    it('yields all the results (larter than max currency)', async () => {
        const results = flatMapAsyncParallel(3, toAsync(['A', 'B', 'C', 'D', 'E']), async function* (item, index) {
            yield `${item}${index}+`;
            await asap();
            yield `${item}${index}-`;
        });
        await assertIterable(results, ['A0+', 'A0-', 'B1+', 'B1-', 'C2+', 'C2-', 'D3+', 'D3-', 'E4+', 'E4-']);
    });
    it('yields nothing if callbacks yield nothing', async () => {
        const results = flatMapAsyncParallel(
            3,
            toAsync(['A', 'B', 'C', 'D', 'E']),
            async function* (): AsyncIterableIterator<never> {
                /* yield nothing */
            },
        );
        await assertIterable(results, []);
    });
    it('yields nothing if the mapped iterable is empty', async () => {
        const results = flatMapAsyncParallel(3, toAsync([]), async function* (item, index) {
            yield `${item}${index}+`;
            yield `${item}${index}-`;
        });
        await assertIterable(results, []);
    });
    it('keeps results in their original order', async () => {
        const defferred1 = deferred<string>();
        const defferred2 = deferred<string>();
        const defferred3 = deferred<string>();
        const results: string[] = [];
        async function startTest() {
            for await (const result of flatMapAsyncParallel(
                3,
                toAsync([defferred1, defferred2, defferred3]),
                async function* (item) {
                    yield await item.promise;
                },
            )) {
                results.push(result);
            }
        }
        startTest();
        await wait();
        assert.deepEqual(results, []);
        defferred2.resolve('B');
        await wait();
        assert.deepEqual(results, []);
        defferred1.resolve('A');
        await wait();
        assert.deepEqual(results, ['A', 'B']);
        defferred3.resolve('C');
        await wait();
        assert.deepEqual(results, ['A', 'B', 'C']);
    });
    it('limits the number of concurrent runs', async () => {
        const calls: number[] = [];
        const d0 = deferred<string>();
        const d1 = deferred<string>();
        const d2 = deferred<string>();
        const d3 = deferred<string>();
        const d4 = deferred<string>();
        const results: string[] = [];
        async function startTest() {
            for await (const result of flatMapAsyncParallel(2, toAsync([d0, d1, d2, d3, d4]), async function* (
                item,
                index,
            ) {
                calls.push(index);
                yield await item.promise;
            })) {
                results.push(result);
            }
        }
        startTest();
        await wait();
        assert.deepEqual(calls, [0, 1]);
        d0.resolve('ok');
        await wait();
        assert.deepEqual(calls, [0, 1, 2]);
        d1.resolve('ok');
        await wait();
        assert.deepEqual(calls, [0, 1, 2, 3]);
        d3.resolve('ok');
        await wait();
        assert.deepEqual(calls, [0, 1, 2, 3, 4]);
    });
});

async function assertIterable<T>(actual: Iterable<T> | AsyncIterable<T>, expected: Iterable<T> | AsyncIterable<T>) {
    const [results1, results2] = await Promise.all([toArray(actual), toArray(expected)]);
    assert.deepEqual(results1, results2);
}
