import { ApiEndpoint, CreateEndpoint, CreateEndpointMethodMapping, endpoint, ListEndpoint, ListEndpointMethodMapping, OptionsEndpointMethodMapping } from './api';
import { User, userResource } from './users';

// tslint:disable-next-line:variable-name
export const _usersCollection: ApiEndpoint<User, never, CreateEndpoint<Pick<User, 'name' | 'email'> & Partial<Pick<User, never>>, Pick<User, 'name' | 'email'> & Partial<Pick<User, never>>, User> & ListEndpoint<{
    ordering: 'name';
    direction: 'asc' | 'desc';
    since?: string | undefined;
} & Pick<User, never>, User>, CreateEndpointMethodMapping<'none'> & ListEndpointMethodMapping<'none'> & OptionsEndpointMethodMapping> = endpoint(userResource)
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
