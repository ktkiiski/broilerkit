import { CreateEndpoint, CreateEndpointMethodMapping, ListEndpoint, ListEndpointMethodMapping, OptionsEndpointMethodMapping } from './api';
import * as localApi from './auth-local-api';
import { Created } from './http';
import { EndpointImplementation, implement } from './server';
import { User } from './users';
import { uuid4 } from './uuid';

// tslint:disable-next-line:variable-name
export const _usersCollection: EndpointImplementation<{}, CreateEndpoint<Pick<User, 'name' | 'email'> & Partial<Pick<User, never>>, Pick<User, 'name' | 'email'> & Partial<Pick<User, never>>, User> & ListEndpoint<{
    ordering: 'name';
    direction: 'asc' | 'desc';
    since?: string | undefined;
} & Pick<User, never>, User>, CreateEndpointMethodMapping<'none'> & ListEndpointMethodMapping<'none'> & OptionsEndpointMethodMapping> = implement(localApi._usersCollection, {})
    .list(async ({ordering, direction, since}, {users}) => {
        return since ? [] : await users.list({
            ordering, direction,
        });
    })
    .create(async ({name, email}, {users}) => {
        const id = uuid4();
        const user = await users.create({id, name, email});
        return new Created(user);
    })
;
