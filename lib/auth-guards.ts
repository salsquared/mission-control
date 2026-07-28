import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { resolveViewer, type Role, type Viewer, type ViewerResult } from './viewer';

// Route guards for the multi-user "owner / crew" model
// (docs/multi-user-crew.html §2.3–§2.4).
//
// WHAT CHANGED, AND WHY THE OLD COMMENT HERE WAS DANGEROUS. Until P1.3 this
// file said the only inbound paths were "the LAN (trusted) and the Access-gated
// tunnel, so any request that arrives is — by construction — the owner", and
// acted on it by synthesizing an owner session from `resolveOwner()` for every
// caller. That premise is now FALSE in both halves: Cloudflare Access admits
// more than one human (crew), and the LAN is not a trust boundary. Left in
// place it would have served a crew member — or anything that can open a socket
// to the origin port — the owner's rows.
//
// Every guard below now resolves identity through the ONE chokepoint,
// `lib/viewer.ts:resolveViewer()`, which reads the Access-verified
// `Cf-Access-Authenticated-User-Email` header and looks up the `User` row it
// names. There is no fallback branch: no `resolveOwner()`, no LAN exemption.
//
// TWO REJECTIONS, NEVER COLLAPSED (§2.3, OQ2a vs OQ3a):
//   401 — "I do not know who you are." No identity header (or, from P4.2, one
//         whose Access JWT fails verification). The fix is at the edge.
//   403 — "I know exactly who you are, and you may not do this." Either a
//         verified Access identity with no `User` row on this instance (the
//         deliberate two-step provisioning of OQ3a — the owner runs
//         `scripts/manage-crew.ts add`), or an authenticated crew viewer on an
//         owner-only route. The fix is provisioning or role, not the edge.
// A client that cannot tell these apart cannot tell "the tunnel is
// misconfigured" from "you need an account", so the bodies below say which.
//
// RETURN SHAPES ARE LOAD-BEARING and deliberately NOT uniform — each guard
// mirrors the one it replaces so no handler body changes:
//   requireSession / requireOwner              → { session } | { error }
//   requireLocalOrSession                      → { ok, session } | { error }
//   requireSessionOrService / requireOwnerOrService → { userId } | { error }
// The synthesized user gained `role`, which is purely ADDITIVE: the ~104 call
// sites and their `session.user.{id,email}` reads are untouched.
//
// NextAuth (`lib/auth.ts`) is retained, but only to mint/refresh the
// Gmail+Calendar token — never as the access gate.

/** The session shape every session-returning guard synthesizes. */
export interface ViewerSession {
  user: { id: string; email: string; role: Role };
}

// Built through this helper (rather than inline per guard) so `role` is always
// the WIDE `Role` type. Inlining it in `requireOwner` would narrow the literal
// to `'owner'` after the role check, and a handler that later compared
// `session.user.role === 'crew'` would become a compile error purely because of
// which guard it happens to use.
function sessionFor(viewer: Viewer): ViewerSession {
  return { user: { id: viewer.id, email: viewer.email, role: viewer.role } };
}

/** The public hostname whose Cloudflare Access app stamps the identity header. */
const ACCESS_HOSTNAME = 'https://mc.salsquared.xyz';

/**
 * Translate a `resolveViewer()` failure into its response. `ViewerResult`'s two
 * failure arms map 1:1 onto the two status codes — this is the only place that
 * mapping lives, so the guards cannot drift apart on it.
 */
function denyViewer(result: Extract<ViewerResult, { ok: false }>): NextResponse {
  if (result.status === 403) {
    return NextResponse.json(
      {
        error: 'Forbidden',
        reason: 'not-provisioned',
        detail:
          `${result.email} was authenticated by Cloudflare Access, but has no account on ` +
          `this instance. Access to the edge is not access to the app — ask the owner to ` +
          `provision this address.`,
      },
      { status: 403 },
    );
  }
  return NextResponse.json(
    {
      error: 'Unauthorized',
      reason: 'no-verified-identity',
      detail:
        `This request carries no Cloudflare-Access-verified identity. Reach the app through ` +
        `${ACCESS_HOSTNAME} (or https://mc-dev.salsquared.xyz on the dev tier) so the edge ` +
        `authenticates you and stamps Cf-Access-Authenticated-User-Email.`,
    },
    { status: 401 },
  );
}

/**
 * A recognised, provisioned viewer who is not the owner. 403, never 401 — they
 * ARE authenticated; the role is what's missing.
 */
function denyNonOwner(viewer: Viewer): NextResponse {
  return NextResponse.json(
    {
      error: 'Forbidden',
      reason: 'owner-only',
      detail:
        `This route is restricted to the owner. ${viewer.email} is signed in as ${viewer.role}.`,
    },
    { status: 403 },
  );
}

// Resolves the current viewer and synthesizes their session. Any signed-in
// viewer passes — owner or crew — so every handler behind this guard MUST scope
// its queries by `session.user.id` (§2.4's second invariant).
export async function requireSession() {
  const result = await resolveViewer();
  if (!result.ok) return { error: denyViewer(result) } as const;
  return { session: sessionFor(result.viewer) } as const;
}

// Owner-only variant of `requireSession`. Same return shape, so swapping a
// route onto it changes exactly two tokens (the import and the call) and no
// handler body. Crew → 403.
export async function requireOwner() {
  const result = await resolveViewer();
  if (!result.ok) return { error: denyViewer(result) } as const;
  if (result.viewer.role !== 'owner') return { error: denyNonOwner(result.viewer) } as const;
  return { session: sessionFor(result.viewer) } as const;
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
//
// Untouched by the owner/crew work: a service token is not a viewer and has no
// role. It authenticates a MACHINE (Pulsar) that is already pinned to one
// user id by config, so there is nothing for `resolveViewer()` to resolve and
// nothing for a role check to check.
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

// Accepts either an interactive viewer OR a configured service token. Service
// callers always go through the strict service-token flow above (env vars +
// matching onBehalfOf); everything else resolves as a viewer.
//
// Returns { userId }, NOT { session } — the handlers behind this guard
// destructure `userId` directly, and the Bearer branch has no session to hand
// them.
export async function requireSessionOrService(req: Request, config: ServiceTokenConfig) {
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return requireServiceToken(req, config);
  }

  const result = await resolveViewer();
  if (!result.ok) return { error: denyViewer(result) } as const;
  return { userId: result.viewer.id } as const;
}

// Owner-only variant of `requireSessionOrService`, for routes that are both
// owner-only and machine-callable (app/api/calendar/event).
//
// Shape: { userId } | { error } — mirroring the guard it replaces, NOT
// requireOwner's { session }. All three handlers in calendar/event do
// `const { userId } = guard;`, so the other shape would break every one.
//
// The owner check applies ONLY on the session branch. The Bearer branch is
// delegated byte-for-byte to `requireServiceToken` above, because Pulsar is not
// a viewer and has no role — adding a role check there would break it.
export async function requireOwnerOrService(req: Request, config: ServiceTokenConfig) {
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return requireServiceToken(req, config);
  }

  const result = await resolveViewer();
  if (!result.ok) return { error: denyViewer(result) } as const;
  if (result.viewer.role !== 'owner') return { error: denyNonOwner(result.viewer) } as const;
  return { userId: result.viewer.id } as const;
}

// Historically "LAN request OR session"; the LAN exemption is gone (there is no
// trusted network any more) so this is now `requireSession` plus a vestigial
// `ok: true` in the success shape, which 29 call sites across 20 route files
// still read. It is kept as a separate export deliberately: collapsing it into
// `requireSession` is a pure-rename change with zero behavioural difference,
// and doing it inside the auth rewrite would bury a 20-file diff in a
// security-sensitive one. Deferred cleanup — see the design doc's P1.3.2.
//
// The `_req` parameter is likewise vestigial (nothing reads the request any
// more) and kept only so the call sites don't have to change.
export async function requireLocalOrSession(_req: Request) {
  const result = await resolveViewer();
  if (!result.ok) return { error: denyViewer(result) } as const;
  return { ok: true as const, session: sessionFor(result.viewer) } as const;
}
