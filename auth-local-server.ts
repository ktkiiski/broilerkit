// tslint:disable:no-shadowed-variable
import * as localApi from './auth-local-api';
import { users } from './cognito';
import { Created } from './http';
import { implementAll } from './server';
import { uuid4 } from './uuid';

export default implementAll(localApi, {users}).using({
    _listUsers: async ({ordering, direction, since}, {users}) => {
        return await users.list({
            ordering, direction, since,
        });
    },
    _createUser: async (props, {users}) => {
        const id = uuid4();
        const user = await users.create({id, ...props});
        return new Created(user);
    },
});
