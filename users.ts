import { datetime, email, nullable, string, url, uuid } from './fields';
import { resource, Resource } from './resources';

export interface User {
    id: string;
    name: string | null;
    email: string | null;
    createdAt: Date;
    updatedAt: Date;
    picture: string | null;
}

export const user: Resource<User, 'id', 'updatedAt'> = resource({
    name: 'user',
    fields: {
        id: uuid(),
        name: nullable(string()),
        email: nullable(email()),
        createdAt: datetime(),
        updatedAt: datetime(),
        picture: nullable(url()),
    },
    identifyBy: ['id'],
    versionBy: 'updatedAt',
});
