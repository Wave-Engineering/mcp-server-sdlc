/**
 * GitHub `fetchCiTrustSignal` adapter implementation — hybrid sub-call landed
 * by Story 2.24 (#318, the FINAL Phase 2 migration).
 *
 * Lifted from `handlers/wave_ci_trust_level.ts`'s `checkGithubTrust` helper.
 * Returns the narrow `(level, reason)` pair that drives the
 * `pre_merge_authoritative | post_merge_required | unknown` classification;
 * the TTL/cache layer stays in the handler.
 *
 * Two-step dispatch:
 *   1. `gh api repos/<slug>/rulesets` — merge queue lives in a ruleset; a
 *      `merge_queue` rule flips the signal to `pre_merge_authoritative`.
 *   2. `gh api repos/<slug>/branches/<default>/protection` — the LIVE default
 *      branch's `required_status_checks.strict` is the secondary
 *      pre-merge-authoritative signal; any other branch-protection shape is
 *      `post_merge_required`. The default branch is resolved via
 *      `resolveDefaultBranchGithubSync` (never hardcoded 'main' — #472: a repo
 *      whose default is e.g. release/1.0.0 would otherwise read the wrong
 *      branch's protection).
 *
 * A subprocess failure on the default-branch resolution or the branch-protection
 * call surfaces as `{ok: false, …}` — the handler folds that into
 * `level: 'unknown'`. A clean rulesets fetch followed by a failed protection
 * fetch is the only real "API error" path we preserve from the pre-migration
 * handler.
 */

import { execSync } from 'child_process';
import { resolveDefaultBranchGithubSync } from './resolve-default-branch-github.js';
import type {
  AdapterResult,
  CiTrustSignal,
  FetchCiTrustSignalArgs,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

// Same charset as fetch-pr-state-github / fetch-issue-closure-github —
// GitHub's owner/repo grammar. Defended at the adapter boundary.
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function resolveSlug(repo: string | undefined): string {
  if (repo === undefined) {
    throw new Error('fetchCiTrustSignalGithub: repo slug is required');
  }
  if (!GITHUB_REPO_SLUG.test(repo)) {
    throw new Error(`fetchCiTrustSignalGithub: invalid repo slug ${JSON.stringify(repo)}`);
  }
  return repo;
}

interface GhRulesetSummary {
  id: number;
  enforcement?: string;
}

interface GhRulesetDetail {
  rules?: Array<{ type?: string }>;
}

interface GhBranchProtection {
  required_status_checks?: { strict?: boolean };
}

function probeRulesets(slug: string): CiTrustSignal | null {
  let rulesets: GhRulesetSummary[];
  try {
    const raw = execSync(`gh api repos/${slug}/rulesets`, { encoding: 'utf8' });
    rulesets = JSON.parse(raw) as GhRulesetSummary[];
  } catch {
    return null; // caller falls through to branch-protection probe
  }
  for (const rs of rulesets) {
    try {
      const detailRaw = execSync(`gh api repos/${slug}/rulesets/${rs.id}`, {
        encoding: 'utf8',
      });
      const detail = JSON.parse(detailRaw) as GhRulesetDetail;
      for (const rule of detail.rules ?? []) {
        if (rule.type === 'merge_queue') {
          return {
            level: 'pre_merge_authoritative',
            reason: 'github merge queue ruleset present',
          };
        }
      }
    } catch {
      // individual ruleset fetch failed — keep scanning
    }
  }
  return null;
}

function probeBranchProtection(slug: string): CiTrustSignal {
  // Resolve the LIVE default branch first — the CI-trust signal must read the
  // default branch's protection, which is not necessarily `main` (#472).
  const defaultBranch = resolveDefaultBranchGithubSync(slug, projectDir());
  const raw = execSync(`gh api repos/${slug}/branches/${defaultBranch}/protection`, {
    encoding: 'utf8',
  });
  const prot = JSON.parse(raw) as GhBranchProtection;
  if (prot.required_status_checks?.strict === true) {
    return {
      level: 'pre_merge_authoritative',
      reason: `github branch protection strict=true on ${defaultBranch}`,
    };
  }
  return {
    level: 'post_merge_required',
    reason: 'github branch protection without strict mode',
  };
}

export function fetchCiTrustSignalGithubSync(repo: string | undefined): CiTrustSignal {
  const slug = resolveSlug(repo);
  const fromRulesets = probeRulesets(slug);
  if (fromRulesets) return fromRulesets;
  return probeBranchProtection(slug);
}

export async function fetchCiTrustSignalGithub(
  args: FetchCiTrustSignalArgs,
): Promise<AdapterResult<CiTrustSignal>> {
  // Bound any exception (subprocess failure, JSON parse error, slug
  // validation) into a typed result — adapter callers must not have to
  // try/catch.
  try {
    const data = fetchCiTrustSignalGithubSync(args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'gh_ci_trust_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
