import base64url from 'base64url';
import { JWK } from 'node-jose';
import { datetime, email, list, nullable, string, url, uuid } from './fields';
import { serializer } from './serializers';
import { decryptToken, encryptToken } from './tokens';

export interface UserSession {
    id: string;
    email: string | null;
    name: string | null;
    picture: string | null;
    groups: string[];
    session: string;
    expiresAt: Date;
    authenticatedAt: Date;
    refreshToken: string;
    refreshAfter: Date;
    refreshedAt: Date;
}

interface UserSessionTokenPayload {
    sub: string;
    name: string | null;
    email: string | null;
    picture: string | null;
    groups: string[];
    auth_time: number;
    exp: number;
    rt: Buffer[];
    ref_at: number;
    ref_after: number;
    sid: string;
}

const userSessionSerializer = serializer({
    id: uuid(),
    name: nullable(string()),
    email: nullable(email()),
    picture: nullable(url()),
    groups: list(string()),
    session: uuid(),
    authenticatedAt: datetime(),
    expiresAt: datetime(),
    refreshToken: string(),
    refreshedAt: datetime(),
    refreshAfter: datetime(),
});

export async function encryptSession(session: UserSession, secretKey: JWK.Key): Promise<string> {
    const validSession = userSessionSerializer.validate(session);
    const tokenCmps = validSession.refreshToken.split('.').map((cmp) => base64url.toBuffer(cmp));
    const payload: UserSessionTokenPayload = {
        sub: validSession.id,
        name: validSession.name,
        email: validSession.email,
        picture: validSession.picture,
        groups: validSession.groups,
        exp: validSession.expiresAt.getTime() / 1000,
        auth_time: validSession.authenticatedAt.getTime() / 1000,
        sid: validSession.session,
        rt: tokenCmps,
        ref_after: session.refreshAfter.getTime() / 1000,
        ref_at: session.refreshedAt.getTime() / 1000,
    };
    return encryptToken(payload, secretKey);
}

export async function decryptSession(token: string, keyStore: JWK.KeyStore): Promise<UserSession> {
    const payload: UserSessionTokenPayload = await decryptToken(token, keyStore);
    const session: UserSession = {
        id: payload.sub,
        name: payload.name,
        email: payload.email,
        picture: payload.picture,
        groups: payload.groups,
        expiresAt: new Date(payload.exp * 1000),
        authenticatedAt: new Date(payload.auth_time * 1000),
        session: payload.sid,
        refreshToken: payload.rt.map((cmp) => base64url.encode(cmp)).join('.'),
        refreshAfter: new Date(payload.ref_after * 1000),
        refreshedAt: new Date(payload.ref_at * 1000),
    };
    return userSessionSerializer.validate(session);
}
