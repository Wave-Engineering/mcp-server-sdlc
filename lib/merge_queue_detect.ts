/**
 * GitHub merge-queue detection for `pr_merge` and `pr_merge_wait`.
 *
 * The merge queue is a repo-level config: when a ruleset enforces it, every
 * merge to the protected branch must enter the queue. `pr_merge`'s `skip_train`
 * flag is meaningless on such repos — the GraphQL config tells us whether to
 * silently drop the flag (#224) and whether to populate `queue.enforced` in
 * the aggregate response (#225 Part A).
 *
 * The single-writer for queue config is GitHub itself; we treat the result as
 * stable for the process lifetime to avoid a graphql round-trip per merge.
 * If the config changes mid-session, the server must be restarted — but the
 * blast radius is small (one stale "enforced" classification per session).
 *
 * Conservative-on-failure semantics: if the GraphQL call fails for any reason
 * (auth, network, repo not found), assume `enabled: false`. The downstream
 * effect is the pre-#225 behavior (skip_train honored, stderr-fallback into
 * the queue path), which is no worse than the status quo.
 */

import { execSync } from 'child_process';

export interface MergeQueueInfo {
  enabled: boolean;
  enforced: boolean;
  // The queue's configured merge strategy ("SQUASH" | "MERGE" | "REBASE").
  // Only present when enabled. Surfaced for caller introspection but not
  // currently consumed by `pr_merge`.
  method?: string;
}

const cache = new Map<string, MergeQueueInfo>();

// Same charset as wave_previous_merged.ts:159 — GitHub's owner/repo grammar.
// Enforcing it at the boundary prevents a maliciously-crafted slug from
// smuggling shell metacharacters through `execSync`.
const GITHUB_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function clearMergeQueueCache(): void {
  cache.clear();
}

const NO_QUEUE: MergeQueueInfo = { enabled: false, enforced: false };

interface GraphqlResponse {
  data?: {
    repository?: {
      mergeQueue?: { mergeMethod?: string } | null;
    };
  };
}

// `repo` is `owner/name`. If the slug is malformed or the GraphQL call fails,
// returns `{enabled:false, enforced:false}` and caches that result for the
// process lifetime — the caller does not need to handle errors.
//
// We currently treat `enabled` and `enforced` as the same boolean: GitHub's
// `mergeQueue` is non-null iff the queue is configured AND ruleset-enforced
// for the protected branch. Future refinement (separate detection via the
// rulesets API) can split them without changing the call site.
export function detectMergeQueue(repo: string): MergeQueueInfo {
  const cached = cache.get(repo);
  if (cached !== undefined) return cached;

  const [owner, name] = repo.split('/', 2);
  if (
    owner === undefined ||
    name === undefined ||
    !GITHUB_SLUG_SEGMENT.test(owner) ||
    !GITHUB_SLUG_SEGMENT.test(name)
  ) {
    cache.set(repo, NO_QUEUE);
    return NO_QUEUE;
  }

  try {
    const query =
      'query($owner:String!,$name:String!)' +
      '{repository(owner:$owner,name:$name){mergeQueue{mergeMethod}}}';
    const raw = execSync(
      `gh api graphql -f 'query=${query}' -F owner=${owner} -F name=${name}`,
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(raw) as GraphqlResponse;
    const mq = parsed.data?.repository?.mergeQueue;
    const result: MergeQueueInfo = mq
      ? { enabled: true, enforced: true, method: mq.mergeMethod }
      : NO_QUEUE;
    cache.set(repo, result);
    return result;
  } catch {
    cache.set(repo, NO_QUEUE);
    return NO_QUEUE;
  }
}
