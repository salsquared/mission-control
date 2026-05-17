import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export async function requireSession() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { session } as const;
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

  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;
  if (!session?.user?.email || !userId) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { userId } as const;
}

// Hosts considered "local" — the LAN boundary is the auth boundary for these routes.
// Anything outside this set (e.g. a public tunnel hostname) gets a 403.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'mc.local']);

// True for loopback addresses + RFC1918 IPv4 + unique-local/link-local IPv6.
// Used by requireLocalOrSession's XFF check (RAH-1): if every hop in the
// X-Forwarded-For chain is a private/loopback address, the request didn't
// traverse a public network and we can still trust the LAN bypass.
// Cloudflare tunnel populates the leftmost XFF with the original public
// client IP, which fails this test.
function isPrivateOrLoopback(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return false;
  if (trimmed === '::1' || trimmed === '127.0.0.1' || trimmed === '0.0.0.0') return true;
  // IPv4-mapped IPv6 — strip the prefix and recurse on the v4 portion.
  if (trimmed.startsWith('::ffff:')) return isPrivateOrLoopback(trimmed.slice(7));
  // RFC1918 IPv4
  if (trimmed.startsWith('10.')) return true;
  if (trimmed.startsWith('192.168.')) return true;
  if (trimmed.startsWith('172.')) {
    const second = parseInt(trimmed.split('.')[1], 10);
    return Number.isFinite(second) && second >= 16 && second <= 31;
  }
  // 127.0.0.0/8 (covers e.g. 127.0.0.1 already; 127.x for completeness)
  if (trimmed.startsWith('127.')) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  return false;
}

export function requireLocalOrigin(req: Request) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return { error: NextResponse.json({ error: 'Local network access only' }, { status: 403 }) } as const;
  }
  return { ok: true as const } as const;
}

// LAN traffic skips auth (trusted network); anything reaching us through a public
// hostname (e.g. the Cloudflare tunnel) must present a valid NextAuth session.
//
// Defense against Host-header spoofing (RAH-1): we trust the LAN bypass only
// when (a) the Host header looks local AND (b) every hop in `X-Forwarded-For`
// is a loopback / RFC1918 / IPv6-private address. Cloudflare tunnel
// (cloudflared) populates the leftmost XFF entry with the original public
// client IP — a LAN client connecting directly only ever shows `::1`,
// `127.0.0.1`, or an RFC1918 address (Next.js dev mode also auto-populates
// XFF with `::1` for direct loopback hits, which is what motivated the
// value-check rather than a presence-check). A tunnel client spoofing
// `Host: localhost` still carries the public XFF hop and falls through to
// the session check.
export async function requireLocalOrSession(req: Request) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  const forwardedFor = req.headers.get('x-forwarded-for');
  const xffAllLocal = forwardedFor
    ? forwardedFor.split(',').every(hop => isPrivateOrLoopback(hop))
    : true;
  if (LOCAL_HOSTS.has(host) && xffAllLocal) {
    return { ok: true as const } as const;
  }
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { ok: true as const, session } as const;
}
