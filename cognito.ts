import { parseARN } from './aws/arn';
import { AmazonCognitoIdentity } from './aws/cognito';
import { Identity, Model, PartialUpdate, Table } from './db';
import { NeDbModel } from './nedb';
import { Page } from './pagination';
import { Resource } from './resources';
import { Serializer } from './serializers';
import { User, user } from './users';
import { mapCached } from './utils/arrays';
import { Omit } from './utils/objects';

export type UserCreateAttributes<S extends User> = Omit<S, 'updatedAt' | 'createdAt'>;
export type UserMutableAttributes<S extends User> = Omit<S, 'id' | 'email' | 'updatedAt' | 'createdAt'>;
export interface UserIdentity {
    id: string;
}
export type UserPartialUpdate<S extends User> = Partial<UserMutableAttributes<S>>;
export type CognitoModel<S extends User = User> = Model<S, UserIdentity, UserCreateAttributes<S>, UserPartialUpdate<S>, {}>;

export class UserPoolCognitoModel<S extends User = User> implements CognitoModel<S> {

    private updateSerializer = this.serializer.omit(['id', 'email', 'updatedAt', 'createdAt']).fullPartial() as Serializer<UserPartialUpdate<S>>;
    private identitySerializer = this.serializer.pick(['id']);

    constructor(private userPoolId: string, private region: string, public serializer: Resource<S, 'id', 'updatedAt'>) {}

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

    public async list(_: {}) {
        // TODO: Improve the query possibilities!
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        const results: S[] = [];
        for await (const cognitoUsers of cognito.listUsers()) {
            results.push(...cognitoUsers);
        }
        return {results, next: null};
    }

    public scan(_: {} = {}): AsyncIterableIterator<S[]> {
        // TODO: Improve
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        return cognito.listUsers();
    }

    public batchRetrieve(identities: UserIdentity[]) {
        const notFoundError = new Error(`Not found`);
        const promises = mapCached(identities, (identity) => (
            this.retrieve(identity, notFoundError).catch((error) => {
                if (error === notFoundError) {
                    return null;
                }
                throw error;
            })
        ));
        return Promise.all(promises);
    }
}

export class LocalCognitoModel<S extends User = User> implements CognitoModel<S> {

    private nedb = new NeDbModel(this.filePath, this.serializer, {
        picture: null,
    });

    constructor(private filePath: string, public readonly serializer: Resource<S, 'id', 'updatedAt'>) {}

    public retrieve(query: UserIdentity, notFoundError?: Error): Promise<S> {
        return this.nedb.retrieve(query as Identity<S, 'id', 'updatedAt'>, notFoundError);
    }

    public create(attrs: UserCreateAttributes<S>): Promise<S> {
        const now = new Date();
        return this.nedb.create({...attrs, updatedAt: now, createdAt: now} as any);
    }

    // tslint:disable-next-line:variable-name
    public replace(_identity: UserIdentity, _item: UserCreateAttributes<S>, _notFoundError?: Error): Promise<S> {
        throw new Error(`Replacing a user is not supported. Use an update instead.`);
    }

    public update(identity: UserIdentity, changes: UserPartialUpdate<S>, notFoundError?: Error): Promise<S> {
        const update = {...changes, updatedAt: new Date()};
        return this.nedb.update(identity as Identity<S, 'id', 'updatedAt'>, update as PartialUpdate<S, 'updatedAt'>, notFoundError);
    }

    public async amend<C extends UserPartialUpdate<S>>(identity: UserIdentity, changes: C, notFoundError?: Error): Promise<C> {
        await this.update(identity, changes, notFoundError);
        return changes;
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public destroy(identity: UserIdentity, notFoundError?: Error) {
        return this.nedb.destroy(identity as Identity<S, 'id', 'updatedAt'>, notFoundError);
    }

    public clear(identity: UserIdentity) {
        return this.nedb.clear(identity as Identity<S, 'id', 'updatedAt'>);
    }

    public list<Q extends {}>(query: {}) {
        return this.nedb.list(query as any) as Promise<Page<S, Q>>;
    }
    public scan(query?: {}): AsyncIterableIterator<S[]> {
        return this.nedb.scan(query as any);
    }
    public batchRetrieve(identities: UserIdentity[]) {
        return this.nedb.batchRetrieve(identities as Array<Identity<S, 'id', 'updatedAt'>>);
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
            return new UserPoolCognitoModel(resourceId, region, user);
        }
        if (uri.startsWith('file://')) {
            const filePath = uri.slice('file://'.length);
            return new LocalCognitoModel(filePath, user);
        }
        throw new Error(`Invalid database table URI ${uri}`);
    },
};
