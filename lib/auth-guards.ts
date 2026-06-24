import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { resolveOwner } from './owner';

// Cloudflare-Access-at-edge auth (docs/cloudflare-access-auth.html).
//
// The access gate now lives at the Cloudflare edge: the only inbound paths to
// the origin are the LAN (trusted) and the Access-gated tunnel, so any request
// that arrives is — by construction — the owner. These guards stop calling
// `getServerSession` and instead synthesize an owner session from
// `resolveOwner()`, preserving their EXACT return shapes so the ~60 route
// callers (and their `session.user.{id,email}` reads) are untouched. NextAuth
// (`lib/auth.ts`) is retained, but only to mint/refresh the Gmail+Calendar
// token — never as the access gate.

// Returns a synthesized owner session. 401 only on the 0-users fresh-machine
// state (genuinely nothing to act as). Populates both `user.id` and
// `user.email` — handlers read both.
export async function requireSession() {
  const owner = await resolveOwner();
  if (!owner) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { session: { user: { id: owner.id, email: owner.email } } } as const;
}

// Naming convention: each external service that needs to call protected routes
// gets a pair of env vars — one holding the shared bearer token, one holding
// the user id that token is bound to. Service callers must include
// `?onBehalfOf=<userId>` matching the configured user id, otherwise 403.
export interface ServiceTokenConfig {
  tokenEnv: string;   // e.g. 'SERVICE_TOKEN_PULSAR'
  userIdEnv: string;  // e.g. 'SERVICE_TOKEN_PULSAR_USER_ID'
}

// Strict service-token check. Returns { userId } on success or { error } on
// any failure. Both env vars must be configured and the request must include
// onBehalfOf matching the configured user id.
export function requireServiceToken(req: Request, config: ServiceTokenConfig) {
  const expectedToken = process.env[config.tokenEnv];
  const expectedUserId = process.env[config.userIdEnv];
  if (!expectedToken || !expectedUserId) {
    return { error: NextResponse.json({ error: 'Service token not configured' }, { status: 401 }) } as const;
  }

  const auth = req.headers.get('authorization');
  if (!auth?.toLowerCase().startsWith('bearer ')) {
    return { error: NextResponse.json({ error: 'Missing Bearer token' }, { status: 401 }) } as const;
  }
  const token = auth.slice(7).trim();
  // Constant-time compare. timingSafeEqual requires equal-length inputs — pad
  // mismatched lengths via the length pre-check so we still fail fast without
  // leaking length via timing.
  const presented = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { error: NextResponse.json({ error: 'Invalid service token' }, { status: 401 }) } as const;
  }

  const url = new URL(req.url);
  const onBehalfOf = url.searchParams.get('onBehalfOf');
  if (!onBehalfOf || onBehalfOf !== expectedUserId) {
    return { error: NextResponse.json({ error: 'onBehalfOf mismatch' }, { status: 403 }) } as const;
  }

  return { userId: expectedUserId } as const;
}

// Accepts either an interactive NextAuth session OR a configured service token.
// Service callers always go through the strict service-token flow above (env
// vars + matching onBehalfOf). Falls back to session if no Bearer is present
// or if the Bearer is for a different (unconfigured) caller.
export async function requireSessionOrService(req: Request, config: ServiceTokenConfig) {
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const result = requireServiceToken(req, config);
    return result;
  }

  // Session branch → owner resolution. The Bearer branch above (machine
  // callers / Pulsar) is unchanged; only the human-traffic branch is now
  // edge-trusted.
  const owner = await resolveOwner();
  if (!owner) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { userId: owner.id } as const;
}

// Edge-trusted: the only inbound paths are the LAN and the Access-gated tunnel,
// so any request reaching the origin is the owner. The LAN/XFF host logic is no
// longer load-bearing for access (the Cloudflare Access app is the gate), so we
// drop straight to owner resolution and synthesize the owner session — keeping
// the `{ ok, session }` return shape the 20 callers read. 401 only on the
// 0-users fresh-machine state.
export async function requireLocalOrSession(_req: Request) {
  const owner = await resolveOwner();
  if (!owner) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { ok: true as const, session: { user: { id: owner.id, email: owner.email } } } as const;
}
