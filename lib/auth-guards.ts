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
