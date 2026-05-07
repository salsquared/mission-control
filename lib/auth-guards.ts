import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth';
import { NextResponse } from 'next/server';

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
  if (token !== expectedToken) {
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

export function requireLocalOrigin(req: Request) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return { error: NextResponse.json({ error: 'Local network access only' }, { status: 403 }) } as const;
  }
  return { ok: true as const } as const;
}

// LAN traffic skips auth (trusted network); anything reaching us through a public
// hostname (e.g. the Cloudflare tunnel) must present a valid NextAuth session.
export async function requireLocalOrSession(req: Request) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  if (LOCAL_HOSTS.has(host)) {
    return { ok: true as const } as const;
  }
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  return { ok: true as const, session } as const;
}
