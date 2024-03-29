import isEqual from 'immuton/isEqual';
import { AmazonCognitoIdentity } from './aws/cognito';
import { batchRetrieve, destroy, retrieve, scan, update, Query } from './db';
import { HttpStatus, isResponse, NotFound } from './http';
import type { DatabaseClient } from './postgres';
import type { Serializer } from './serializers';
import { User, users } from './users';

interface UserIdentity {
    id: string;
}
type UserPartialUpdate = Partial<Omit<User, 'id' | 'email' | 'updatedAt' | 'createdAt'>>;

export interface UserPool {
    retrieve(query: UserIdentity): Promise<User>;
    update(identity: UserIdentity, changes: UserPartialUpdate): Promise<User>;
    destroy(identity: UserIdentity): Promise<void>;
    scan(): AsyncIterableIterator<User[]>;
    batchRetrieve(identities: UserIdentity[]): Promise<(User | null)[]>;
}

function fail(): never {
    throw new Error('User pool is not configured');
}

export class DummyUserPool implements UserPool {
    public retrieve(): never {
        fail();
    }

    public update(): never {
        fail();
    }

    public destroy(): never {
        fail();
    }

    public scan(): never {
        fail();
    }

    public batchRetrieve(): never {
        fail();
    }
}

export class CognitoUserPool implements UserPool {
    private updateSerializer = users
        .omit(['id', 'email', 'updatedAt', 'createdAt'])
        .fullPartial() as Serializer<UserPartialUpdate>;

    private identitySerializer = users.pick(['id']);

    constructor(private userPoolId: string, private region: string) {}

    public async retrieve(query: UserIdentity): Promise<User> {
        const { identitySerializer } = this;
        const serializedQuery = identitySerializer.serialize(query);
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
        const cognitoUser = await cognito.getUserById(serializedQuery.id, new NotFound(`User not found.`));
        // No deserialization needed
        return cognitoUser;
    }

    public async update(identity: UserIdentity, changes: UserPartialUpdate): Promise<User> {
        const { identitySerializer, updateSerializer } = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedChanges = updateSerializer.serialize(changes);
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
        const cognitoUser = await cognito.updateUserById(
            serializedIdentity.id,
            serializedChanges,
            new NotFound(`User not found.`),
        );
        // No deserialization needed
        return cognitoUser;
    }

    public async destroy(identity: UserIdentity): Promise<void> {
        const { identitySerializer } = this;
        const serializedIdentity = identitySerializer.serialize(identity);
        const serializedId = serializedIdentity.id;
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
        await cognito.deleteUserById(serializedId, new NotFound(`User not found.`));
    }

    public scan(): AsyncIterableIterator<User[]> {
        const cognito = new AmazonCognitoIdentity<User>(this.region, this.userPoolId);
        return cognito.listUsers();
    }

    public batchRetrieve(identities: UserIdentity[]): Promise<(User | null)[]> {
        const promises = mapCached(identities, (identity) =>
            this.retrieve(identity).catch((error) => {
                if (isResponse(error, HttpStatus.NotFound)) {
                    return null;
                }
                throw error;
            }),
        );
        return Promise.all(promises);
    }
}

export class LocalUserPool implements UserPool {
    constructor(private readonly db: DatabaseClient) {}

    public retrieve(query: UserIdentity): Promise<User> {
        return this.db.run(retrieve(users, query as Pick<User, 'id'>));
    }

    public update(identity: UserIdentity, changes: UserPartialUpdate): Promise<User> {
        const updates = { ...changes, updatedAt: new Date() };
        return this.db.run(update(users, identity as Pick<User, 'id'>, updates as Partial<User>));
    }

    public destroy(identity: UserIdentity): Promise<void> {
        return this.db.run(destroy(users, identity as Pick<User, 'id'>));
    }

    public scan(query?: Record<never, never>): AsyncIterableIterator<User[]> {
        return this.db.scan(scan(users, query as Query<User>));
    }

    public batchRetrieve(identities: UserIdentity[]): Promise<(User | null)[]> {
        return this.db.run(batchRetrieve(users, identities as Pick<User, 'id'>[]));
    }
}

/**
 * Maps each item in the given array, but does not call the
 * iterator function for values that have already been called.
 * The equality is compared with isEqual function.
 * @param items Items to map
 * @param callback Function to be called for each distinct value
 */
export function mapCached<T, R>(items: T[], callback: (item: T) => R): R[] {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const reuseIndex = items.slice(0, i).findIndex((x) => isEqual(x, item));
        if (reuseIndex < 0) {
            // Not yet cached
            results.push(callback(item));
        } else {
            // Use a cached result
            results.push(results[reuseIndex]);
        }
    }
    return results;
}
