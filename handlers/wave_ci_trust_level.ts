// CI trust-level classification handler — adapter-dispatching shell.
// Platform-specific ruleset/branch-protection (GitHub) and
// `merge_trains_enabled` (GitLab) probing lives in
// lib/adapters/fetch-ci-trust-signal-{github,gitlab}.ts. The per-project TTL
// cache stays HERE — the adapter is the cache-miss path. See Story 2.24 (#318,
// FINAL Phase 2 migration).

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({}).strict();

type TrustLevel = 'pre_merge_authoritative' | 'post_merge_required' | 'unknown';

interface TrustResult {
  level: TrustLevel;
  reason: string;
  cache_ttl_seconds: number;
}

const CACHE_TTL_SECONDS = 3600;

// Per-process cache keyed by project root.
const cache = new Map<string, TrustResult>();

function projectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

async function computeTrust(): Promise<TrustResult> {
  const slug = parseRepoSlug() ?? undefined;
  const res = await getAdapter({ repo: slug }).fetchCiTrustSignal({ repo: slug });
  if ('platform_unsupported' in res) return { level: 'unknown', reason: res.hint, cache_ttl_seconds: CACHE_TTL_SECONDS };
  if (!res.ok) return { level: 'unknown', reason: res.error, cache_ttl_seconds: CACHE_TTL_SECONDS };
  return { ...res.data, cache_ttl_seconds: CACHE_TTL_SECONDS };
}

const waveCiTrustLevelHandler: HandlerDef = {
  name: 'wave_ci_trust_level',
  description: 'Detect whether the platform guarantees pre-merge CI == post-merge CI',
  inputSchema,
  async execute(rawArgs: unknown) {
    try { inputSchema.parse(rawArgs); }
    catch (err) { return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    try {
      const key = projectRoot();
      let result = cache.get(key);
      if (!result) { result = await computeTrust(); cache.set(key, result); }
      return envelope({ ok: true, ...result });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

// Exported for tests to reset cache between cases.
export function __resetCache() {
  cache.clear();
}

export default waveCiTrustLevelHandler;
