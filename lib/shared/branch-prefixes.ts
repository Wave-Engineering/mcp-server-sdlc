/**
 * Canonical branch-prefix set (#449).
 *
 * The allowed branch prefixes are SINGULAR — the prefix names the topic, not the
 * file type: `doc/` not `docs/`. A plural/unknown prefix is the most common
 * mistake (#448) and must surface as an unrecognized-prefix error, never as
 * "no linked issue".
 *
 * Single source of truth shared by `handlers/ibm.ts` (branch-format validation)
 * and `lib/wave-reconcile.ts` (`issueNumberFromBranch`) so the accepted set can
 * never drift apart. CLAUDE.md's Branching Strategy section documents the same
 * list and is held in sync by `tests/branch_prefixes_doc.test.ts`.
 */
export const BRANCH_PREFIXES = ['feature', 'fix', 'chore', 'doc', 'bug', 'kahuna'] as const;
