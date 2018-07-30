import { endpoint } from './api';
import { userResource } from './users';

// tslint:disable-next-line:variable-name
export const _usersCollection = endpoint(userResource, 'id')
    .url `/_users`
    .listable({
        orderingKeys: ['name'],
        auth: 'none',
    })
    .creatable({
        auth: 'none',
        required: ['email', 'name'],
        optional: [],
        defaults: {},
    })
;
