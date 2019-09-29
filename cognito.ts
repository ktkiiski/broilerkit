import { AmazonCognitoIdentity } from './aws/cognito';
import { getResourceState, Identity, Model, ModelContext, PartialUpdate, Query, Table } from './db';
import { ValidationError } from './errors';
import { HttpStatus, isResponse, NotFound } from './http';
import { Page } from './pagination';
import { PostgreSqlDbModel } from './postgres';
import { Resource } from './resources';
import { Serializer } from './serializers';
import { User, user } from './users';
import { mapCached, order } from './utils/arrays';
import { Key } from './utils/objects';

export type UserCreateAttributes<S extends User> = Omit<S, 'updatedAt' | 'createdAt'>;
export type UserMutableAttributes<S extends User> = Omit<S, 'id' | 'email' | 'updatedAt' | 'createdAt'>;
export interface UserIdentity {
    id: string;
}
export type UserPartialUpdate<S extends User> = Partial<UserMutableAttributes<S>>;
export type CognitoModel<S extends User = User> = Model<S, UserIdentity, UserCreateAttributes<S>, UserPartialUpdate<S>, Query<S>>;

const localUsersTableName = '_users';

class UserPoolCognitoModel<S extends User = User> implements CognitoModel<S> {

    private updateSerializer = this.serializer.omit(['id', 'email', 'updatedAt', 'createdAt']).fullPartial() as Serializer<UserPartialUpdate<S>>;
    private identitySerializer = this.serializer.pick(['id']);

    constructor(private userPoolId: string, private region: string, public serializer: Resource<S, 'id', 'updatedAt'>) {}

    public async retrieve(query: UserIdentity): Promise<S> {
        const {identitySerializer} = this;
        const serializedQuery = identitySerializer.serialize(query);
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        const cognitoUser = await cognito.getUserById(serializedQuery.id, new NotFound(`User not found.`));
        // No deserialization needed
        return cognitoUser;
    }

    public create(_: UserCreateAttributes<S>): Promise<S> {
        throw new Error(`Creating users is not supported. They need to sign up`);
    }

    // tslint:disable-next-line:variable-name
    public replace(_identity: UserIdentity, _item: UserCreateAttributes<S>): Promise<S> {
        throw new Error(`Replacing a user is not supported. Use an update instead.`);
    }

    public async update(identity: UserIdentity, changes: UserPartialUpdate<S>): Promise<S> {
        const {identitySerializer, updateSerializer} = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedChanges = updateSerializer.serialize(changes);
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        const cognitoUser = await cognito.updateUserById(serializedIdentity.id, serializedChanges, new NotFound(`User not found.`));
        // No deserialization needed
        return cognitoUser;
    }

    public async amend<C extends UserPartialUpdate<S>>(identity: UserIdentity, changes: C): Promise<C> {
        await this.update(identity, changes);
        return changes;
    }

    public async upsert(): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public async destroy(identity: UserIdentity) {
        const {identitySerializer} = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedId = serializedIdentity.id;
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        await cognito.deleteUserById(serializedId, new NotFound(`User not found.`));
    }

    public async clear(identity: UserIdentity) {
        try {
            return await this.destroy(identity);
        } catch (error) {
            if (!isResponse(error, HttpStatus.NotFound)) {
                throw error;
            }
        }
    }

    public async list<Q extends Query<S>>({ direction, ordering, since, ...filters }: Q) {
        // TODO: Improve the query possibilities!
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        const results: S[] = [];
        const filterKeys = Object.keys(filters);
        if (filterKeys.length > 1) {
            throw new ValidationError(`Only one filtering key supported when listing users`);
        }
        const options: {filterKey?: string, filterValue?: string} = {};
        if (filterKeys.length) {
            const filterKey = filterKeys[0] as Key<S>;
            const { serializer } = this;
            const field = serializer.fields[filterKey];
            options.filterKey = filterKey;
            options.filterValue = field.encode((filters as any)[filterKey]);
        }
        for await (const cognitoUsers of cognito.listUsers(options)) {
            results.push(...cognitoUsers);
        }
        return {
            results: order(results, ordering, direction, since),
            next: null,
        };
    }

    public scan(_: {} = {}): AsyncIterableIterator<S[]> {
        // TODO: Improve
        const cognito = new AmazonCognitoIdentity<S>(this.region, this.userPoolId);
        return cognito.listUsers();
    }

    public batchRetrieve(identities: UserIdentity[]) {
        const promises = mapCached(identities, (identity) => (
            this.retrieve(identity).catch((error) => {
                if (isResponse(error, HttpStatus.NotFound)) {
                    return null;
                }
                throw error;
            })
        ));
        return Promise.all(promises);
    }
}

class LocalCognitoModel<S extends User = User> implements CognitoModel<S> {

    private db = new PostgreSqlDbModel(this.context, localUsersTableName, this.serializer);

    constructor(
        private readonly context: ModelContext,
        public readonly serializer: Resource<S, 'id', 'updatedAt'>,
    ) {}

    public retrieve(query: UserIdentity): Promise<S> {
        return this.db.retrieve(query as Identity<S, 'id', 'updatedAt'>);
    }

    public create(attrs: UserCreateAttributes<S>): Promise<S> {
        const now = new Date();
        return this.db.create({...attrs, updatedAt: now, createdAt: now} as any);
    }

    // tslint:disable-next-line:variable-name
    public replace(_identity: UserIdentity, _item: UserCreateAttributes<S>): Promise<S> {
        throw new Error(`Replacing a user is not supported. Use an update instead.`);
    }

    public update(identity: UserIdentity, changes: UserPartialUpdate<S>): Promise<S> {
        const update = {...changes, updatedAt: new Date()};
        return this.db.update(identity as Identity<S, 'id', 'updatedAt'>, update as PartialUpdate<S, 'updatedAt'>);
    }

    public async amend<C extends UserPartialUpdate<S>>(identity: UserIdentity, changes: C): Promise<C> {
        await this.update(identity, changes);
        return changes;
    }

    public async upsert(): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public async write(_: S): Promise<S> {
        throw new Error(`Not yet implemented!`);
    }

    public destroy(identity: UserIdentity) {
        return this.db.destroy(identity as Identity<S, 'id', 'updatedAt'>);
    }

    public clear(identity: UserIdentity) {
        return this.db.clear(identity as Identity<S, 'id', 'updatedAt'>);
    }

    public list<Q extends Query<S>>(query: Q) {
        return this.db.list(query as any) as Promise<Page<S, Q>>;
    }
    public scan(query?: {}): AsyncIterableIterator<S[]> {
        return this.db.scan(query as any);
    }
    public batchRetrieve(identities: UserIdentity[]) {
        return this.db.batchRetrieve(identities as Array<Identity<S, 'id', 'updatedAt'>>);
    }
}

export const users: Table<CognitoModel> = {
    name: 'Users',
    resource: user,
    indexes: [],
    getModel(context: ModelContext): CognitoModel {
        const { region, environment } = context;
        // TODO: Better handling for situation where user registry is not enabled
        if (region === 'local') {
            return new LocalCognitoModel(context, user) as CognitoModel;
        } else {
            const userPoolId = environment.UserPoolId;
            if (!userPoolId) {
                throw new Error('Missing user pool ID!');
            }
            return new UserPoolCognitoModel(userPoolId, region, user);
        }
    },
    getState() {
        return getResourceState(localUsersTableName, this.resource, [
            ['email'],
            ['createdAt'],
        ]);
    },
};
