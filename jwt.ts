import { KJUR, b64utoutf8 } from 'jsrsasign';

export interface JWTPayload {
    exp: number;
    iat: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

/**
 * Generates a signed JWT token using the given payload.
 * @param payload token payload object
 * @param secret secret used to sign the token
 */
export function signJwt(payload: Record<string, unknown>, secret: string): string {
    const alg = 'HS256';
    const sHeader = JSON.stringify({ alg, typ: 'JWT' });
    const sPayload = JSON.stringify(payload);
    return KJUR.jws.JWS.sign(alg, sHeader, sPayload, secret);
}
/**
 * Parses a JSON Web Token (JWT) string and returns the payload object.
 * @param token JWT string to parse
 */
export function parseJwt(token: string): JWTPayload {
    const base64Url = token.split('.')[1];
    const json = b64utoutf8(base64Url);
    const payload = KJUR.jws.JWS.readSafeJSONString(json);
    if (!payload) {
        throw new Error('Cannot parse JWT payload');
    }
    return payload as JWTPayload;
}
