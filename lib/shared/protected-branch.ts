/**
 * Protected-branch naming convention (#470).
 *
 * BJ's rule: a branch is "protected" iff its NAME is `main` or `release/*` —
 * those are the ONLY protected patterns. Protection is a naming convention, NOT
 * a host query: no admin-permission requirement, no rate-limit / fail-closed
 * risk, no rulesets / protected_branches lookup.
 *
 * Single source of truth shared by `handlers/ibm.ts` and
 * `handlers/branch_guard.ts` so the two can never drift apart.
 */
export const PROTECTED_BRANCH_PATTERN = /^(main|release\/.+)$/;
