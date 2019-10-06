import * as assert from 'assert';
import { JWK } from 'node-jose';
import { decryptSession, encryptSession } from '../sessions';

const exampleRefreshToken = `eyJjdHkiOiJKV1QiLdsfsdfsdMjU2R0NNIiwiYWxnIjoiUlNBLU9BRVAifQ.CoZZ0filEm6jYCm64Uc8MfXSGMzE7cngoFcMjr2dY9EsdfasdfadfsfadsfasdfagadczvcxzbbvbfdzvcxzvzcxczvzxvcE194dcCFD-KzSSagbTrtjKWMuhu2OVAALQes1q4jUT3Rcg4KoTETJ2RLlIJnvf4Pp_Jh34bScEWvF4sYug2PAw44sgz5TQ3Lp5EuBV_TQPru25lTzrnH7Y7vtY1-mWjY2wlSSOoobnVnxi8IUrKRNxi_OMJneTDqOOw.p-aRDfsA_y9_VgXQ.gTo7W6KfItDR6Bk7LhkP0SFMbmJz2FT5P4Cj8vMgASvSZkRIWuJfDrhsM7AwotIk8NOMc6t0daUTY8wRlRlaS3AZ8Cm2hSgPLWs1zqWOoHBGFbGBvNY9bqQZud1jM5XcLibUb1_Jqsu7LBUbBWu461d4ypwlbFSgIN53TCg6WBrfWncc7ZB4Eit9__Cyg0HmYz-jmpbzGiav76hA1Ji4oSw8aYYbrzleyh1nwAHyw4aOF6bupBgV88sgAcnH4WSocToqfB64cxrR8DSA8fvvgj2qdySTv1e6oKTWXKruzeoYJ1sF2z2a7RIHGsa3FK6XyGsHiWkcnrtV7Opl39e5iGXHJ5BRDwrA926n_kALEV4NcG4yLabiqc6SzO1YQbqkYFkJixeL4oMRSCRXyWyNoYccicFuh112Tdk6Z-3JXbV0xZoGNcWmVrIydzT-hLyaCY00P4IkeluL7sPJEsWTvB3As1F9Vx7s4bWgm4iQUfOea6M0iJu8gtd6CUtOL6SecXStayO7oGCct-9e8D9t2cwmTlp2dDikDDd86mdxlN75anoCPYi99kEslSLoj2h3isOIPhn0nnh-ZAG-ln85gbLlv07YqxlO7rlKX4N9K3Hv8Fhpl9pMLRpXgVVbYmNjYXK8Y1NLFviw0FRd10AsNshZ2Sb0rhMQ77zlfW56FoaqJva78gWEDY8ZH6mj75o5up_wJdOMhrz72TOoNvZjSwERuRUGC37aVSl4DYM5VgGR0MdQaslWGlhaQobd9lSb_5uV7ibHfaRBNVy3fDtdRXetd18OTz37yaPHDfkSXmrTCGXvPDV4pG6hg3mZpB7RyI94A5ZkCI5BAgoOfdbmce7JyymLVvOqS9o1zDJ6r2zabfFT1H00ZpNRfLDV1Q4a3n1nHLUNSzbTph3HaJ4fn7I72iKDqn-0UeObP2640qGeI5K2VsNO0AtVzvgI_t7tqNdgEfoiYtseliIJ_rYEpwzaKDt33-zh57zuwEmE86F6P_j6KN0uajcFZkVGtdtDX7dRNSJbMhjaVsWz-72Fx4QUJ0Nu0rxHcC74A8QbialN-mCwMbiZehbP6xLm65ntFAMyDUDl2AP02VrOl_P7290v9ryAPnqt1hFh0CTWnbAlTgnRReIwv5yk64YgLvsFV68ENzwwg45Z-Z7bBGADk0fTpTypWMmbGf3WThjXdjC97Iz0g8MHhsMqynSddHVHCsgI7zVZ7rxw8YhC38wM8rb9zA42E7YzRLxrmpUuCfxAtWhU-97BevU6uDBCgp2FHo8YQOmleJNwzYFh7w.3xlqUobOFP_V1a-H7-tGnQ`;
const exampleSession = {
    id: 'e48d7449-cc37-4886-bdbd-ff248b64d167',
    email: 'john.smith@example.com',
    name: 'John Smith',
    picture: 'https://example.com/john.smith.jpg',
    expiresAt: new Date(),
    refreshToken: exampleRefreshToken,
};

describe('encryptSession()', () => {
    let keyStore: JWK.KeyStore;
    let secretKey: JWK.Key;
    beforeEach(async () => {
        keyStore = JWK.createKeyStore();
        secretKey = await keyStore.generate('oct', 256, { alg: 'A256GCM' });
    });
    it('returns dot-separated base64url encoded string', async () => {
        const token = await encryptSession(exampleSession, secretKey);
        const parts = token.split('.');
        assert.strictEqual(parts.length, 5);
        assert(/^[A-Za-z0-9_-]+$/.exec(parts[0]));
        assert.strictEqual(parts[1], '');
        assert(/^[A-Za-z0-9_-]+$/.exec(parts[2]));
        assert(/^[A-Za-z0-9_-]+$/.exec(parts[3]));
        assert(/^[A-Za-z0-9_-]+$/.exec(parts[4]));
    });
    it('returns different encryption with each call', async () => {
        const token1 = await encryptSession(exampleSession, secretKey);
        const token2 = await encryptSession(exampleSession, secretKey);
        assert.notEqual(token1, token2);
    });
    it('returns a token significantly smaller than 4096 bytes', async () => {
        const token = await encryptSession(exampleSession, secretKey);
        assert(token.length < 4096 / 2);
    });
});
describe('descryptSession()', () => {
    let keyStore: JWK.KeyStore;
    let secretKey: JWK.Key;
    beforeEach(async () => {
        keyStore = JWK.createKeyStore();
        secretKey = await keyStore.generate('oct', 256, { alg: 'A256GCM' });
    });
    it('returns payload encrypted with `encryptSession`', async () => {
        const token = await encryptSession(exampleSession, secretKey);
        const decrypted = await decryptSession(token, keyStore);
        assert.deepEqual(decrypted, exampleSession);
    });
    it('fails if decrypting an unknown token', async () => {
        await assert.rejects(
            decryptSession('foobar', keyStore),
        );
    });
    it('fails if decrypted with unknown secret key', async () => {
        const anotherSecretKey = await JWK.createKey('oct', 256, { alg: 'A256GCM' });
        const token = await encryptSession(exampleSession, anotherSecretKey);
        await assert.rejects(
            decryptSession(token, keyStore),
            {
                name: 'Error',
                message: 'no key found',
            },
        );
    });
});
