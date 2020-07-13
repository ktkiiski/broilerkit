import * as assert from 'assert';
import { JWK } from 'node-jose';
import { decryptSession, encryptSession, UserSession } from '../sessions';

const exampleRefreshToken = `eyJraWQiOiJwT2tMN0tyRnFPNmFVdzhxc3J0Y0RhSThwb2wxU2wyT2VyalJQK0h6YWtjPSIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiIyYTc2NmUzNC02NThiLTQ2YmItOGY2Zi0zMjgwZDkzNjFjYTEiLCJjb2duaXRvOmdyb3VwcyI6WyJ1cy1lYXN0LTFfMlV3VEJLVUdUX0ZhY2Vib29rIl0sInRva2VuX3VzZSI6ImFjY2VzcyIsInNjb3BlIjoib3BlbmlkIiwiYXV0aF90aW1lIjoxNTcwMDQ0NTg5LCJpc3MiOiJodHRwczpcL1wvY29nbml0by1pZHAudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cL3VzLWVhc3QtMV8yVXdUQktVR1QiLCJleHAiOjE1NzAwNDgxODksImlhdCI6MTU3MDA0NDU5MCwidmVyc2lvbiI6MiwianRpIjoiNTJhYTEyNzItZWU4NS00ZmQ5LTljMTMtMGE2NzY1ZTg1OGM0IiwiY2xpZW50X2lkIjoiNzFvM2Y1Y211bGg4Z2hzNDl2dTMydGpkZDYiLCJ1c2VybmFtZSI6IkZhY2Vib29rXzEwMTUzMTAyMTk4NDI0NzQyIn0.OVAKMqo91m5gt2DaToIzRazB1z7j1rXbLBBTHLeuM7_aMxx86jZuK9VvQSHsDvPQlxh4Pl2afA6jHIXAmlRyOnJMZ3H0tqPAG6BKO2CzQiJQ9i9PvDkSXiGv9Il7zpSkUspjJQF_i75pCUeWgD9sTD9eA6KWp58EufkWPMF4wOlD4UJIo-8WT8m0UoihrL_JPg1qA3Lubj2KAJPp4jYKynyaX-U1A0uVkNo4MleeaIxulBiZ-kg7OHe8kh197RM7JSxFPU4UPVmSmCA9zwxurgIgA_QxWdtDWdc4E7xxgppOPP3w_nLcHKL1VZKVmvpD9CBMO9-SoASSWm-QXP5rbg`;
const exampleSession: UserSession = {
    id: 'e48d7449-cc37-4886-bdbd-ff248b64d167',
    email: 'john.smith@example.com',
    name: 'John Smith',
    picture: 'https://example.com/john.smith.jpg',
    session: '39209622-f7b1-4085-b493-d3b425fd7b94',
    groups: ['Administrators'],
    expiresAt: new Date(),
    authenticatedAt: new Date(),
    refreshToken: exampleRefreshToken,
    refreshAfter: new Date(),
    refreshedAt: new Date(),
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
        assert(token.length < 2048, `Token length ${token.length} was larger than 2048`);
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
        await assert.rejects(decryptSession('foobar', keyStore));
    });
    it('fails if decrypted with unknown secret key', async () => {
        const anotherSecretKey = await JWK.createKey('oct', 256, { alg: 'A256GCM' });
        const token = await encryptSession(exampleSession, anotherSecretKey);
        await assert.rejects(decryptSession(token, keyStore), {
            name: 'Error',
            message: 'no key found',
        });
    });
});
