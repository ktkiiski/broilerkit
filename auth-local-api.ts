// tslint:disable:variable-name
import { endpoint } from './endpoints';
import { creatable, listable } from './operations';
import { pattern } from './url';
import { user } from './users';

const usersCollection = endpoint(user, pattern `/_users`);

export const _listUsers = listable(usersCollection, {
    auth: 'none',
    orderingKeys: ['name'],
});
export const _createUser = creatable(usersCollection, {
    auth: 'none',
    required: ['email', 'name'],
    optional: [],
    defaults: {
        picture: null,
    },
});
