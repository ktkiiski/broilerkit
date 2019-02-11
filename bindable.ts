import { from, Observable, OperatorFunction, Subscribable } from 'rxjs';
import { pipeFromArray } from 'rxjs/internal/util/pipe';
import { map } from 'rxjs/operators';
import { Client } from './client';
import { Omit } from './utils/objects';

export interface Bindable<T> {
    bind(client: Client): T;
}
export interface Connectable<I, O> {
    connect(props$: Subscribable<I>): Observable<O>;
}

export abstract class BindableConnectable<I, O> implements Bindable<Connectable<I, O>> {
    public abstract bind(client: Client): Connectable<I, O>;

    public with<K extends keyof I>(props: Pick<I, K>): BindableConnectable<Omit<I, K>, O> {
        return new MappedInputBindableConnectable(
            this, map((inputProps: Omit<I, K>) => ({...inputProps, ...props}) as I),
        );
    }

    public map<R>(fn: (input: O) => R): BindableConnectable<I, R> {
        return new MappedOutputBindableConnectable(this, map(fn));
    }

    public pipe<A>(op1: OperatorFunction<O, A>): BindableConnectable<I, A>;
    public pipe<A, B>(op1: OperatorFunction<O, A>, op2: OperatorFunction<A, B>): BindableConnectable<I, B>;
    public pipe<A, B, C>(op1: OperatorFunction<O, A>, op2: OperatorFunction<A, B>, op3: OperatorFunction<B, C>): BindableConnectable<I, C>;
    public pipe<A, B, C, D>(op1: OperatorFunction<O, A>, op2: OperatorFunction<A, B>, op3: OperatorFunction<B, C>, op4: OperatorFunction<C, D>): BindableConnectable<I, D>;
    public pipe<A, B, C, D, E>(op1: OperatorFunction<O, A>, op2: OperatorFunction<A, B>, op3: OperatorFunction<B, C>, op4: OperatorFunction<C, D>, op5: OperatorFunction<D, E>): BindableConnectable<I, E>;
    public pipe<A, B, C, D, E, F>(op1: OperatorFunction<O, A>, op2: OperatorFunction<A, B>, op3: OperatorFunction<B, C>, op4: OperatorFunction<C, D>, op5: OperatorFunction<D, E>, op6: OperatorFunction<E, F>): BindableConnectable<I, F>;
    public pipe<A, B, C, D, E, F, G>(op1: OperatorFunction<O, A>, op2: OperatorFunction<A, B>, op3: OperatorFunction<B, C>, op4: OperatorFunction<C, D>, op5: OperatorFunction<D, E>, op6: OperatorFunction<E, F>, op7: OperatorFunction<F, G>): BindableConnectable<I, G>;
    public pipe<A, B, C, D, E, F, G, H>(op1: OperatorFunction<O, A>, op2: OperatorFunction<A, B>, op3: OperatorFunction<B, C>, op4: OperatorFunction<C, D>, op5: OperatorFunction<D, E>, op6: OperatorFunction<E, F>, op7: OperatorFunction<F, G>, op8: OperatorFunction<G, H>): BindableConnectable<I, H>;
    public pipe(...ops: Array<OperatorFunction<any, any>>): BindableConnectable<I, any> {
        return new MappedOutputBindableConnectable(this, pipeFromArray(ops));
    }
}

// export function selectThrough<I1, O1, I2, O2, N extends string, K1 extends keyof I1>(
//     options: SelectThroughOptions<I1, O1, I2, O2, N, K1>,
// ): SelectThroughBindableConnectable<I1, O1, I2, O2, N, K1> {
//     return new SelectThroughBindableConnectable<I1, O1, I2, O2, N, K1>(options);
// }

// interface SelectThroughOptions<I1, O1, I2, O2, N extends string, K1 extends keyof I1> {
//     source: Bindable<Connectable<I1, O1[]>>;
//     nested: Bindable<Connectable<I2, O2[]>>;
//     nestedAt: N;
//     using: {[P in K1]: keyof O2};
// }

class MappedInputBindableConnectable<I1, I2, O>
extends BindableConnectable<I2, O> {
    constructor(
        private source: Bindable<Connectable<I1, O>>,
        private op: OperatorFunction<I2, I1>,
    ) {
        super();
    }

    public bind(client: Client): Connectable<I2, O> {
        const boundSource = this.source.bind(client);
        return {
            connect: (props$) => boundSource.connect(
                from(props$).pipe(this.op),
            ),
        };
    }
}

class MappedOutputBindableConnectable<I, O1, O2>
extends BindableConnectable<I, O2> {
    constructor(
        private source: Bindable<Connectable<I, O1>>,
        private op: OperatorFunction<O1, O2>,
    ) {
        super();
    }

    public bind(client: Client): Connectable<I, O2> {
        const boundSource = this.source.bind(client);
        return {
            connect: (props$) => boundSource.connect(props$).pipe(this.op),
        };
    }
}

// class SelectThroughBindableConnectable<I1, O1, I2, O2, N extends string, K1 extends keyof I1>
// extends BindableConnectable<Omit<I1, K1> & I2, Array<O1 & Record<N, O2>>> {
//     constructor(private options: SelectThroughOptions<I1, O1, I2, O2, N, K1>) {
//         super();
//     }
//     public bind(client: Client): Connectable<Omit<I1, K1> & I2, Array<O1 & Record<N, O2>>> {
//         const {source, nested, nestedAt, using} = this.options;
//         const boundSource = source.bind(client);
//         const boundNested = nested.bind(client);
//         return {
//             connect: (props$) => combineLatest(
//                 boundNested.connect(props$), props$,
//                 (nestedItems, props) => nestedItems.map((nestedItem) => ({
//                     ...props,
//                     ...transformValues(using, (nestedKey) => nestedItem[nestedKey] as unknown),
//                 })),
//             ).pipe(
//                 distinctUntilChanged(isEqual),
//                 switchMap((selectors) => !selectors.length ? [[]] : combineLatest(
//                     selectors
//                         .map((selector) => boundSource.connect(of(selector as I1)).pipe(
//                             map((ratings) => ratings.map((rating) => ({...rating, profile: selector}))),
//                         )),
//                 )),
//                 map((ratingCollections) => new Array<DetailedRating>().concat(...ratingCollections)),
//             ),
//         };
//     }
// }
