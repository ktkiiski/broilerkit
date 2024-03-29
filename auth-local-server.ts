import flatten from 'immuton/flatten';
import order from 'immuton/order';
import { toArray } from './async';
import * as localApi from './auth-local-api';
import { create } from './db';
import { Created } from './http';
import { implementAll } from './server';
import { users } from './users';
import { uuid4 } from './uuid';

export default implementAll(localApi).using({
    // eslint-disable-next-line @typescript-eslint/no-shadow
    _listUsers: async ({ direction, ordering, since }, { users }) => ({
        results: order(flatten(await toArray(users.scan())), ordering, direction, since),
        next: null,
    }),
    _createUser: async (props, { db }) => {
        const id = uuid4();
        const now = new Date();
        const user = await db.run(
            create(users, {
                id,
                ...props,
                updatedAt: now,
                createdAt: now,
            }),
        );
        return new Created(user);
    },
});
