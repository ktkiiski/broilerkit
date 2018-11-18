import * as localApi from './auth-local-api';
import { Created } from './http';
import { implement } from './server';
import { uuid4 } from './uuid';

// tslint:disable-next-line:variable-name
export const _usersCollection = implement(localApi._usersCollection, {})
    .list(async ({ordering, direction, since}, {users}) => {
        return await users.list({
            ordering, direction, since,
        });
    })
    .create(async (props, {users}) => {
        const id = uuid4();
        const user = await users.create({id, ...props});
        return new Created(user);
    })
;
