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
    .create(async ({name, email, picture}, {users}) => {
        const id = uuid4();
        const user = await users.create({id, name, email, picture});
        return new Created(user);
    })
;
