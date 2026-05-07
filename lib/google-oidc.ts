import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';

// Google's JWKS for OIDC tokens. createRemoteJWKSet caches per-kid in memory
// with rotation handling — fetch is on first use and on key-id miss.
const JWKS = createRemoteJWKSet(
    new URL('https://www.googleapis.com/oauth2/v3/certs'),
    { cacheMaxAge: 24 * 60 * 60 * 1000 } // 24 hours
);

const GOOGLE_ISSUER = 'https://accounts.google.com';

export interface PubSubOIDCClaims extends JWTPayload {
    email?: string;
    email_verified?: boolean;
}

// Verifies a Bearer OIDC JWT attached by Google Cloud Pub/Sub push.
// Pub/Sub signs the token with the configured push-subscription service account;
// the audience claim must match what we configured (typically the route URL).
//
// Throws on any verification failure — caller is expected to translate to 401.
// On success, returns the verified payload (notably the signing service-account email).
export async function verifyPubSubOIDC(req: Request, audience: string): Promise<PubSubOIDCClaims> {
    const auth = req.headers.get('authorization');
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
        throw new Error('Missing Bearer token');
    }
    const token = auth.slice(7).trim();
    if (!token) {
        throw new Error('Empty Bearer token');
    }

    const { payload } = await jwtVerify(token, JWKS, {
        issuer: GOOGLE_ISSUER,
        audience,
        algorithms: ['RS256'],
    });

    return payload as PubSubOIDCClaims;
}
