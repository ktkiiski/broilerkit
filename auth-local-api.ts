/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable no-underscore-dangle */
import { endpoint } from './endpoints';
import { creatable, listable } from './operations';
import { pattern } from './url';
import { users } from './users';

const usersCollection = endpoint(users, pattern`/_users`);

export const _listUsers = listable(usersCollection, {
    auth: 'none',
    orderingKeys: ['name', 'createdAt', 'email'],
});
export const _createUser = creatable(usersCollection, {
    auth: 'none',
    required: ['email', 'name'],
    optional: [],
    defaults: {
        name: null,
        email: null,
        picture: null,
    },
});
