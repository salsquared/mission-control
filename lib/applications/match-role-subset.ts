import { normalizeRoleName } from "@/lib/applications/normalize-role";

/**
 * Lenient role-drift matcher (2026-06-04, Astranis→Muon Space repro).
 *
 * The strict primary dedup (`findApplicationByCompanyAndRole`) compares the
 * full normalizedRole, so a confirmation email that drops a term suffix the
 * tracked posting carried — "Software Engineer Intern - Data Platform
 * (Summer 2026)" (tracked) vs the email's bare "Software Engineer Intern -
 * Data Platform" — misses the existing card and would spawn a duplicate.
 *
 * Given the incoming role string and the candidate applications already scoped
 * to ONE employer, this returns the single candidate whose normalizedRole token
 * set is a STRICT SUPERSET of the incoming role's tokens. The "exactly one"
 * gate is the safety property: a generic short role that is a subset of several
 * siblings (e.g. "Software Engineering Intern" matching four distinct Hermeus
 * specializations) is ambiguous → `match: null`, so the caller falls through to
 * senderDomain / create rather than guessing onto the wrong card.
 *
 * Direction is deliberately one-way (stored ⊇ incoming): the observed drift is
 * the email DROPPING tokens the posting had. An exact-equal role never reaches
 * here (the strict lookup already matched it), hence STRICT superset.
 *
 * `ambiguousCount` lets the caller log the >1 case distinctly from the 0 case.
 */
export interface RoleSubsetCandidate {
    normalizedRole: string | null;
}

export interface RoleSubsetResult<T> {
    match: T | null;
    /** How many candidates were strict supersets (0 = none, >1 = ambiguous). */
    supersetCount: number;
}

export function findUniqueRoleSuperset<T extends RoleSubsetCandidate>(
    incomingRole: string,
    candidates: readonly T[],
): RoleSubsetResult<T> {
    const incomingSet = new Set(
        normalizeRoleName(incomingRole).split(" ").filter(Boolean),
    );
    // Empty incoming role = the roleless case the company-only branch owns;
    // a subset-of-everything match here would be meaningless. Decline.
    if (incomingSet.size === 0) return { match: null, supersetCount: 0 };

    const supersets = candidates.filter((c) => {
        if (!c.normalizedRole) return false;
        const stored = new Set(c.normalizedRole.split(" ").filter(Boolean));
        return (
            stored.size > incomingSet.size
            && [...incomingSet].every((t) => stored.has(t))
        );
    });

    return {
        match: supersets.length === 1 ? supersets[0] : null,
        supersetCount: supersets.length,
    };
}
