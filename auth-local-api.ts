import { endpoint } from './api';
import { user } from './users';

// tslint:disable-next-line:variable-name
export const _usersCollection = endpoint(user)
    .url `/_users`
    .listable({
        orderingKeys: ['name'],
        auth: 'none',
    })
    .creatable({
        auth: 'none',
        required: ['email', 'name'],
        optional: [],
        defaults: {
            picture: null,
        },
    })
;
