/* eslint-disable @typescript-eslint/no-explicit-any */
import { CognitoIdentityServiceProvider } from 'aws-sdk';
import mapObject from 'immuton/mapObject';
import { NotFound } from '../http';
import { retrievePages } from './utils';

export interface CognitoUser {
    id: string;
    username: string;
    name: string;
    email: string;
    updatedAt: Date;
    createdAt: Date;
    picture: string | null;
}

export class AmazonCognitoIdentity<S = Record<never, never>> {
    private cognito = new CognitoIdentityServiceProvider({
        region: this.region,
        maxRetries: 20,
    });
    constructor(private region: string, private userPoolId: string) {}

    public async getUserById(id: string, notFoundError?: Error): Promise<CognitoUser & S> {
        for await (const users of this.listUsers({limit: 1, filterKey: 'sub', filterValue: id})) {
            for (const user of users) {
                return user;
            }
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
        return {...user, attrs};
    }

    public async deleteUserById(id: string, notFoundError?: Error): Promise<void> {
        const user = await this.getUserById(id, notFoundError);
        const request = this.cognito.adminDeleteUser({
            Username: user.username,
            UserPoolId: this.userPoolId,
        });
        await request.promise();
    }

    public async *listUsers(options?: {limit?: number, filterKey?: string, filterValue?: string}): AsyncIterableIterator<(CognitoUser & S)[]> {
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
                    const results: (CognitoUser & S)[] = [];
                    const {Attributes, Username} = user;
                    if (Attributes && Username) {
                        const result: any = {
                            username: Username,
                            createdAt: user.UserCreateDate,
                            updatedAt: user.UserLastModifiedDate,
                        };
                        for (const {Name, Value} of Attributes) {
                            if (Value != null) {
                                if (Name === 'picture') {
                                    result.picture = parsePictureUrl(Value);
                                } else {
                                    result[Name === 'sub' ? 'id' : Name] = Value;
                                }
                            }
                        }
                        results.push(result);
                    }
                    yield results;
                }
            }
        }
    }
}

function parsePictureUrl(picture: string): string | null {
    /**
     * The picture attribute is either:
     * - picture URL already (Google)
     * - the following object (Facebook)
     * {
     *   "id": "123124312412412",
     *   "name": "John Smith",
     *   "picture": {
     *     "data": {
     *       "height": 50,
     *       "is_silhouette": false,
     *       "url": "https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=123124312412412&height=50&width=50&ext=23423423&hash=asfasf",
     *       "width": 50
     *     }
     *   }
     * }
     */
    // Try to parse and get the nested value
    try {
        picture = JSON.parse(picture).data.url;
    } catch {
        return null;
    }
    if (typeof picture === 'string' && /^https?:\/\//.test(picture)) {
        return picture;
    }
    return null;
}
