import { datetime, email, nullable, string, url, uuid } from './fields';
import { Resource, resource } from './resources';

export interface User {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
    picture: string | null;
}

export const user: Resource<User> = resource({
    id: uuid(),
    name: string(),
    email: email(),
    createdAt: datetime(),
    updatedAt: datetime(),
    picture: nullable(url()),
});
