// tslint:disable:variable-name
import { endpoint } from './api';
import { pattern } from './url';
import { user } from './users';

const usersCollection = endpoint(user, pattern `/_users`);

export const _listUsers = usersCollection.listable({
    auth: 'none',
    orderingKeys: ['name'],
});
export const _createUser = usersCollection.creatable({
    auth: 'none',
    required: ['email', 'name'],
    optional: [],
    defaults: {
        picture: null,
    },
});
