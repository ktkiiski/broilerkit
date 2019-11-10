import { AmazonCognitoIdentity } from './aws/cognito';
import { Identity, PartialUpdate, table } from './db';
import { HttpStatus, isResponse, NotFound } from './http';
import { DatabaseClient } from './postgres';
import { Serializer } from './serializers';
import { User, user } from './users';
import { mapCached } from './utils/arrays';

interface UserIdentity { id: string; }
type UserPartialUpdate = Partial<Omit<User, 'id' | 'email' | 'updatedAt' | 'createdAt'>>;

export interface UserPool {
    retrieve(query: UserIdentity): Promise<User>;
    update(identity: UserIdentity, changes: UserPartialUpdate): Promise<User>;
    destroy(identity: UserIdentity): Promise<void>;
    scan(): AsyncIterableIterator<User[]>;
    batchRetrieve(identities: UserIdentity[]): Promise<Array<User | null>>;
}

export class DummyUserPool implements UserPool {
    public retrieve(): never {
        throw new Error('User pool is not configured');
    }
    public update(): never {
        throw new Error('User pool is not configured');
    }
    public destroy(): never {
        throw new Error('User pool is not configured');
    }
    public scan(): never {
        throw new Error('User pool is not configured');
    }
    public batchRetrieve(): never {
        throw new Error('User pool is not configured');
    }
}

export class CognitoUserPool implements UserPool {

    private updateSerializer = user
        .omit(['id', 'email', 'updatedAt', 'createdAt'])
        .fullPartial() as Serializer<UserPartialUpdate>;
    private identitySerializer = user.pick(['id']);

    constructor(private userPoolId: string, private region: string) {}

    public async retrieve(query: UserIdentity): Promise<User> {
        const {identitySerializer} = this;
        const serializedQuery = identitySerializer.serialize(query);
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
        const cognitoUser = await cognito.getUserById(serializedQuery.id, new NotFound(`User not found.`));
        // No deserialization needed
        return cognitoUser;
    }

    public async update(identity: UserIdentity, changes: UserPartialUpdate): Promise<User> {
        const {identitySerializer, updateSerializer} = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedChanges = updateSerializer.serialize(changes);
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
        const cognitoUser = await cognito.updateUserById(serializedIdentity.id, serializedChanges, new NotFound(`User not found.`));
        // No deserialization needed
        return cognitoUser;
    }

    public async destroy(identity: UserIdentity) {
        const {identitySerializer} = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedId = serializedIdentity.id;
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
        await cognito.deleteUserById(serializedId, new NotFound(`User not found.`));
    }

    public scan(): AsyncIterableIterator<User[]> {
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
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

export class LocalUserPool implements UserPool {

    constructor(
        private readonly db: DatabaseClient,
    ) {}

    public retrieve(query: UserIdentity): Promise<User> {
        return this.db.run(
            localUsers.retrieve(query as Identity<User, 'id', 'updatedAt'>),
        );
    }

    public update(identity: UserIdentity, changes: UserPartialUpdate): Promise<User> {
        const update = {...changes, updatedAt: new Date()};
        return this.db.run(
            localUsers.update(identity as Identity<User, 'id', 'updatedAt'>, update as PartialUpdate<User, 'updatedAt'>),
        );
    }

    public destroy(identity: UserIdentity) {
        return this.db.run(
            localUsers.destroy(identity as Identity<User, 'id', 'updatedAt'>),
        );
    }

    public scan(query?: {}): AsyncIterableIterator<User[]> {
        return this.db.scan(
            localUsers.scan(query as any),
        );
    }

    public batchRetrieve(identities: UserIdentity[]) {
        return this.db.run(
            localUsers.batchRetrieve(identities as Array<Identity<User, 'id', 'updatedAt'>>),
        );
    }
}

export const localUsers = table(user, '_users')
    .index('name')
    .index('email')
    .index('createdAt');
