import { CognitoIdentityServiceProvider } from 'aws-sdk';
import { NotFound } from '../http';
import { mapObject, spread } from '../utils/objects';
import { retrievePages } from './utils';

export interface CognitoUser {
    id: string;
    username: string;
    name: string;
    email: string;
    updatedAt: Date;
    createdAt: Date;
}

export class AmazonCognitoIdentity<S = {}> {
    private cognito = new CognitoIdentityServiceProvider({region: this.region});
    constructor(private region: string, private userPoolId: string) {}

    public async getUserById(id: string, notFoundError?: Error): Promise<CognitoUser & S> {
        for await (const user of this.listUsers({limit: 1, filterKey: 'sub', filterValue: id})) {
            return user;
        }
        throw notFoundError || new NotFound(`User was not found.`);
    }

    public async updateUserById<T extends {[attr: string]: string}>(id: string, attrs: T, notFoundError?: Error): Promise<CognitoUser & S> {
        const user = await this.getUserById(id, notFoundError);
        const request = this.cognito.adminUpdateUserAttributes({
            Username: user.username,
            UserPoolId: this.userPoolId,
            UserAttributes: mapObject(attrs, (Value, Name) => ({Name, Value})),
        });
        try {
            await request.promise();
        } catch (error) {
            if (error.code === 'UserNotFoundException') {
                throw notFoundError || new NotFound(`User was not found.`);
            }
            throw error;
        }
        return spread(user, attrs);
    }

    public async deleteUserById(id: string, notFoundError?: Error): Promise<void> {
        const user = await this.getUserById(id, notFoundError);
        const request = this.cognito.adminDeleteUser({
            Username: user.username,
            UserPoolId: this.userPoolId,
        });
        await request.promise();
    }

    public async *listUsers(options?: {limit?: number, filterKey?: string, filterValue?: string}): AsyncIterableIterator<CognitoUser & S> {
        const limit = options && options.limit;
        const filterKey = options && options.filterKey;
        const filterValue = options && options.filterValue;
        const filter = filterKey && filterValue != null ? `${filterKey} = ${JSON.stringify(filterValue)}` : undefined;
        const request = this.cognito.listUsers({
            UserPoolId: this.userPoolId,
            Limit: limit,
            Filter: filter,
        });
        for await (const users of retrievePages(request, 'Users')) {
            if (users) {
                for (const user of users) {
                    const {Attributes, Username} = user;
                    if (Attributes && Username) {
                        const result: any = {
                            username: Username,
                            createdAt: user.UserCreateDate,
                            updatedAt: user.UserLastModifiedDate,
                        };
                        for (const {Name, Value} of Attributes) {
                            if (Value != null) {
                                result[Name === 'sub' ? 'id' : Name] = Value;
                            }
                        }
                        yield result as CognitoUser & S;
                    }
                }
            }
        }
    }
}
