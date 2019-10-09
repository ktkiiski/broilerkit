import * as msgpack from 'msgpack-lite';
import { JWE, JWK } from 'node-jose';

export async function encryptToken(payload: {[key: string]: any}, secretKey: JWK.Key): Promise<string> {
    const packaged = msgpack.encode(payload);
    return JWE.createEncrypt({ format: 'compact' }, secretKey)
        .update(packaged).final();
}

export async function decryptToken(token: string, keyStore: JWK.KeyStore): Promise<any> {
    const decryption = await JWE.createDecrypt(keyStore).decrypt(token);
    return msgpack.decode(decryption.plaintext);
}
