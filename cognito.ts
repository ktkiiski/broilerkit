import { toArray } from './async';
import { parseARN } from './aws/arn';
import { AmazonCognitoIdentity } from './aws/cognito';
import { Model, Table } from './db';
import { NeDbModel } from './nedb';
import { Resource, Serializer } from './resources';
import { User, userResource } from './users';
import { order } from './utils/arrays';
import { Omit, spread } from './utils/objects';

export type UserCreateAttributes<S extends User> = Omit<S, 'updatedAt' | 'createdAt'>;
export type UserMutableAttributes<S extends User> = Omit<S, 'id' | 'email' | 'updatedAt' | 'createdAt'>;
export interface UserIdentity {
    id: string;
}
export type UserPartialUpdate<S extends User> = Partial<UserMutableAttributes<S>>;
export interface UserQuery<S extends User> {
    ordering: keyof UserMutableAttributes<S>;
    direction: 'asc' | 'desc';
    maxCount?: number;
}

export type CognitoModel<S extends User = User> = Model<S, UserIdentity, UserCreateAttributes<S>, UserPartialUpdate<S>, UserQuery<S>>;

export class UserPoolCognitoModel<S extends User = User> implements CognitoModel<S> {

    private updateSerializer = this.serializer.omit(['id', 'email', 'updatedAt', 'createdAt']).partial() as Serializer<UserPartialUpdate<S>>;
    private identitySerializer = this.serializer.pick(['id']);

    constructor(private userPoolId: string, private region: string, private serializer: Resource<S>) {}

    public async retrieve(query: UserIdentity, notFoundError?: Error): Promise<S> {
        const {identitySerializer} = this;
        const serializedQuery = identitySerializer.serialize(query);
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        const cognitoUser = await cognito.getUserById(serializedQuery.id, notFoundError);
        // No deserialization needed
        return cognitoUser;
    }

    public create(_: UserCreateAttributes<S>): Promise<S> {
        throw new Error(`Creating users is not supported. They need to sign up`);
    }

    // tslint:disable-next-line:variable-name
    public replace(_identity: UserIdentity, _item: UserCreateAttributes<S>, _notFoundError?: Error): Promise<S> {
        throw new Error(`Replacing a user is not supported. Use an update instead.`);
    }

    public async update(identity: UserIdentity, changes: UserPartialUpdate<S>, notFoundError?: Error): Promise<S> {
        const {identitySerializer, updateSerializer} = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedChanges = updateSerializer.serialize(changes);
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        const cognitoUser = await cognito.updateUserById(serializedIdentity.id, serializedChanges, notFoundError);
        // No deserialization needed
        return cognitoUser;
    }

    public async amend<C extends UserPartialUpdate<S>>(identity: UserIdentity, changes: C, notFoundError?: Error): Promise<C> {
        await this.update(identity, changes, notFoundError);
        return changes;
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public async destroy(identity: UserIdentity, notFoundError?: Error) {
        const {identitySerializer} = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedId = serializedIdentity.id;
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        await cognito.deleteUserById(serializedId, notFoundError);
    }

    public async clear(identity: UserIdentity) {
        const notFound = new Error(`Not found`);
        try {
            return await this.destroy(identity, notFound);
        } catch (error) {
            if (error !== notFound) {
                throw error;
            }
        }
    }

    public async list(query: UserQuery<S>) {
        // TODO: Improve the query possibilities!
        const { ordering, direction } = query;
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        const cognitoUsers = await toArray(cognito.listUsers({limit: query.maxCount}));
        return order(cognitoUsers, ordering, direction) as S[];
    }
}

export class LocalCognitoModel<S extends User = User> implements CognitoModel<S> {

    private nedb = new NeDbModel(this.filePath, this.serializer, 'id', 'updatedAt');

    constructor(private filePath: string, private serializer: Resource<S>) {}

    public retrieve(query: UserIdentity, notFoundError?: Error): Promise<S> {
        return this.nedb.retrieve(query, notFoundError);
    }

    public create(attrs: UserCreateAttributes<S>): Promise<S> {
        const now = new Date();
        return this.nedb.create(spread(attrs, {updatedAt: now, createdAt: now}) as any);
    }

    // tslint:disable-next-line:variable-name
    public replace(_identity: UserIdentity, _item: UserCreateAttributes<S>, _notFoundError?: Error): Promise<S> {
        throw new Error(`Replacing a user is not supported. Use an update instead.`);
    }

    public update(identity: UserIdentity, changes: UserPartialUpdate<S>, notFoundError?: Error): Promise<S> {
        return this.nedb.update(identity, spread(changes, {updatedAt: new Date()}), notFoundError);
    }

    public async amend<C extends UserPartialUpdate<S>>(identity: UserIdentity, changes: C, notFoundError?: Error): Promise<C> {
        await this.update(identity, changes, notFoundError);
        return changes;
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public destroy(identity: UserIdentity, notFoundError?: Error) {
        return this.nedb.destroy(identity, notFoundError);
    }

    public clear(identity: UserIdentity) {
        return this.nedb.clear(identity);
    }

    public list({direction, maxCount = 99999999, ordering}: UserQuery<S>) {
        // TODO: Max count!
        return this.nedb.list({direction, minCount: 1, maxCount, ordering});
    }
}

export const users: Table<CognitoModel> = {
    name: 'Users',
    getModel(uri: string): CognitoModel {
        // TODO: Better handling for situation where user registry is not enabled
        if (!uri) {
            return {} as CognitoModel;
        }
        if (uri.startsWith('arn:')) {
            const {service, region, resourceType, resourceId} = parseARN(uri);
            if (service !== 'cognito-idp') {
                throw new Error(`Unknown AWS service "${service}" for user registry`);
            }
            if (resourceType !== 'userpool') {
                throw new Error(`Unknown AWS resource type "${resourceType}" for user registry`);
            }
            return new UserPoolCognitoModel(resourceId, region, userResource);
        }
        if (uri.startsWith('file://')) {
            const filePath = uri.slice('file://'.length);
            return new LocalCognitoModel(filePath, userResource);
        }
        throw new Error(`Invalid database table URI ${uri}`);
    },
};
