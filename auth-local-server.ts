// tslint:disable:no-shadowed-variable
import { toArray } from './async';
import * as localApi from './auth-local-api';
import { localUsers } from './cognito';
import { Created } from './http';
import { implementAll } from './server';
import { flatten, order } from './utils/arrays';
import { uuid4 } from './uuid';

export default implementAll(localApi).using({
    _listUsers: async ({ direction, ordering, since }, { users }) => {
        return {
            results: order(
                flatten(await toArray(users.scan())),
                ordering, direction, since,
            ),
            next: null,
        };
    },
    _createUser: async (props, { db }) => {
        const id = uuid4();
        const now = new Date();
        const user = await db.run(localUsers.create({
            id, ...props,
            updatedAt: now,
            createdAt: now,
        }));
        return new Created(user);
    },
});
