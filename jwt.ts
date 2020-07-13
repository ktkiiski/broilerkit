/* eslint-disable @typescript-eslint/no-explicit-any */
export interface JWTPayload {
    exp: number;
    iat: number;
    [key: string]: any;
}

/**
 * Parses a JSON Web Token (JWT) string and returns the payload object.
 * @param token JWT string to parse
 */
export function parseJwt(token: string): JWTPayload {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(window.atob(base64));
}
