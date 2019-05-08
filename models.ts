import { firestore } from 'firebase';
import { Condition } from './conditions';
import { ValidationError } from './errors';
import { Field } from './fields';
import { Serializer } from './serializers';
import { OptionalUndefined } from './utils/objects';

export interface ResourceQuery<T> {
  input: any; // TODO: Explicit typing?
  validationError: ValidationError | null;
  // TODO: Explicit error type
  subscribe(fstore: firestore.Firestore, onSnapshot: (resource: T) => void, onError: (error: unknown) => void): () => void;
}

export interface CollectionQuery<T> {
  input: any; // TODO: Explicit typing?
  ordering: keyof T; // TODO: Explicit typing?
  direction: 'asc' | 'desc';
  limit?: number;
  validationError: ValidationError | null;
  // TODO: Explicit error type
  subscribe(fstore: firestore.Firestore, onSnapshot: (resource: T[]) => void, onError: (error: unknown) => void): () => void;
}

interface ReadConfig<T, Q, O extends keyof T, R extends keyof T> {
  auth: 'none' | 'user';
  ordering: O[];
  properties: {[P in keyof T]?: Condition<T[P], any>} & {[P in R]: Condition<T[P], any>} & {[P in keyof Q]: Condition<any, Q[P]>};
}

interface WriteConfig<T, W, R extends keyof T> {
  auth: 'none' | 'user';
  properties: {[P in keyof T]: Condition<T[P], any>} & {[P in R]: Condition<T[P], any>} & {[P in keyof W]: Condition<any, W[P]>};
}

interface DeleteConfig<T, Q, I extends keyof T, R extends keyof T> {
  auth: 'none' | 'user';
  properties: {[P in I]: Condition<T[P], any>} & {[P in R]: Condition<T[P], any>} & {[P in keyof Q]: Condition<any, Q[P]>};
}

type Fields<T> = {[P in keyof T]: Field<T[P]>};

interface CollectionOptions<T, I extends keyof T> {
  name: string;
  fields: Fields<T>;
  identifyBy: I[];
}

interface Relation<K, V> {
  keys: K[];
  values: V[];
}

interface NestedCollectionOptions<S, SI extends keyof S, RK, RV> {
  name: string;
  relation: Relation<RK, RV>;
  fields: Fields<S>;
  identifyBy: SI[];
}

interface Collection<T, I extends keyof T, R extends keyof T = never> {
  name: string;
  serializer: Serializer<T>;
  fields: Fields<T>;
  identifyBy: I[];
  parent: Collection<any, any> | null;
  listable<Q, O extends keyof T>(config: ReadConfig<T, Q, O, R>): Listable<T, Input<T, Q>, Input<T, Q> & Pick<T, Exclude<I, keyof Q>>, O>;
  creatable<W>(config: WriteConfig<T, W, R>): Operation<T, Input<T, W>>;
  updateable<W>(config: WriteConfig<T, W, R>): Operation<T, Input<T, W>>;
  deleteable<Q>(config: DeleteConfig<T, Q, I, R>): Operation<void, Input<T, Q>>;
}

// TODO: Can be simplified
type Input<T, W> = OptionalUndefined<{[P in keyof T & keyof W]: W[P] extends 'excluded' ? undefined : W[P] extends 'optional' ? T[P] | undefined : T[P]}>;

export function relation<K extends keyof any, V extends keyof any>(r: Record<K, V>): Relation<K, V> {
  return null as any;
}

export function collection<T, I extends keyof T>(res: CollectionOptions<T, I>): Collection<T, I> {
  return null as any;
}

export function subCollection<T, TI extends keyof T, S, SI extends keyof S, R extends keyof S>(parent: Collection<T, TI>, res: NestedCollectionOptions<S, SI, TI, R>): Collection<S, SI & TI, R> {
  return null as any;
}

export interface Action {
  collection: Collection<any, any>;
  actionName: 'read' | 'create' | 'update' | 'delete';
  auth: 'none' | 'user';
  properties: {[key: string]: Condition<any, any>};
}

export interface Retrieveable<T, Q> {
  one(input: Q): ResourceQuery<T>;
}

export interface Listable<T, Q, R, O extends keyof T> extends Retrieveable<T, R>, Action {
  all(input: Q, ordering: O, direction: 'asc' | 'desc', limit?: number): CollectionQuery<T>;
}

export interface Operation<T, Q> extends Action {
  run(fs: firestore.Firestore, input: Q): Promise<T>;
}
