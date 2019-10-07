import base64url from 'base64url';
import { JWK } from 'node-jose';
import { AuthUser } from './auth';
import { datetime, email, nullable, string, url, uuid } from './fields';
import { serializer } from './serializers';
import { decryptToken, encryptToken } from './tokens';

interface UserSession extends AuthUser {
    session: string;
    expiresAt: Date;
    authenticatedAt: Date;
    refreshToken: string;
}

interface UserSessionTokenPayload {
    sub: string;
    name: string;
    email: string;
    pic: string | null;
    auth_time: number;
    exp: number;
    rt: Buffer[];
    sid: string;
}

const userSessionSerializer = serializer({
    id: uuid(),
    name: string(),
    email: email(),
    picture: nullable(url()),
    session: uuid(),
    authenticatedAt: datetime(),
    expiresAt: datetime(),
    refreshToken: string(),
});

export async function encryptSession(session: UserSession, secretKey: JWK.Key): Promise<string> {
    const validSession = userSessionSerializer.validate(session);
    const tokenCmps = validSession.refreshToken.split('.')
        .map((cmp) => base64url.toBuffer(cmp));
    const payload: UserSessionTokenPayload = {
        sub: validSession.id,
        name: validSession.name,
        email: validSession.email,
        pic: validSession.picture,
        exp: validSession.expiresAt.valueOf(),
        auth_time: validSession.authenticatedAt.valueOf(),
        sid: validSession.session,
        rt: tokenCmps,
    };
    return encryptToken(payload, secretKey);
}

export async function decryptSession(token: string, keyStore: JWK.KeyStore): Promise<UserSession> {
    const payload: UserSessionTokenPayload = await decryptToken(token, keyStore);
    const session: UserSession = {
        id: payload.sub,
        name: payload.name,
        email: payload.email,
        picture: payload.pic,
        expiresAt: new Date(payload.exp),
        authenticatedAt: new Date(payload.auth_time),
        session: payload.sid,
        refreshToken: payload.rt.map((cmp) => base64url.encode(cmp)).join('.'),
    };
    return userSessionSerializer.validate(session);
}
