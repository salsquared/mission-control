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
