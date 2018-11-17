import { datetime, email, nullable, string, url, uuid } from './fields';
import { resource, VersionedResource } from './resources';

export interface User {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
    picture: string | null;
}

export const user: VersionedResource<User, 'id', 'updatedAt'> = resource({
    fields: {
        id: uuid(),
        name: string(),
        email: email(),
        createdAt: datetime(),
        updatedAt: datetime(),
        picture: nullable(url()),
    },
    identifyBy: ['id'],
    versionBy: 'updatedAt',
});
