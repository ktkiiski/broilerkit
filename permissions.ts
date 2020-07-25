/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Unauthorized } from './http';
import type { Operation } from './operations';
import type { UserSession } from './sessions';

export function authorize(operation: Operation<any, any, any>, auth: UserSession | null, input: any): void {
    const { authType, userIdAttribute } = operation;
    const isAdmin = !!auth && auth.groups.indexOf('Administrators') < 0;
    if (authType !== 'none') {
        if (!auth) {
            throw new Unauthorized(`Unauthorized`);
        }
        if (authType === 'admin' && !isAdmin) {
            // Not an admin!
            throw new Unauthorized(`Administrator rights are missing.`);
        }
        if (authType === 'owner' && userIdAttribute) {
            // Needs to be either owner or admin!
            // TODO: Handle invalid configuration where auth == 'owner' && !userIdAttribute!
            const value = input[userIdAttribute];
            if (userIdAttribute && value !== auth.id && !isAdmin) {
                throw new Unauthorized(`Unauthorized resource`);
            }
        }
    }
}
