import base64url from 'base64url';
import { JWK } from 'node-jose';
import { AuthUser } from './auth';
import { datetime, email, nullable, string, url, uuid } from './fields';
import { serializer } from './serializers';
import { decryptToken, encryptToken } from './tokens';

interface UserSession extends AuthUser {
    expiresAt: Date;
    refreshToken: string;
}

const userSessionSerializer = serializer({
    id: uuid(),
    name: string(),
    email: email(),
    picture: nullable(url()),
    expiresAt: datetime(),
    refreshToken: string(),
});

export async function encryptSession(session: UserSession, secretKey: JWK.Key): Promise<string> {
    const validSession = userSessionSerializer.validate(session);
    const tokenCmps = validSession.refreshToken.split('.')
        .map((cmp) => base64url.toBuffer(cmp));
    const payload: {[key: string]: any} = {
        id: validSession.id,
        name: validSession.name,
        email: validSession.email,
        pic: validSession.picture,
        exp: validSession.expiresAt.valueOf(),
        rt: tokenCmps,
    };
    return encryptToken(payload, secretKey);
}

export async function decryptSession(token: string, keyStore: JWK.KeyStore): Promise<UserSession> {
    const payload = await decryptToken(token, keyStore);
    const tokenCmps = payload.rt as string[];
    const session: any = {
        id: payload.id,
        name: payload.name,
        email: payload.email,
        picture: payload.pic,
        expiresAt: new Date(payload.exp),
        refreshToken: tokenCmps.map((cmp) => base64url.encode(cmp)).join('.'),
    };
    return userSessionSerializer.validate(session);
}
