import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { gitlabApiRepo } from '../lib/glab.js';

const inputSchema = z.object({}).strict();

type TrustLevel = 'pre_merge_authoritative' | 'post_merge_required' | 'unknown';

interface TrustResult {
  level: TrustLevel;
  reason: string;
  cache_ttl_seconds: number;
}

// Per-process cache keyed by project root.
const cache = new Map<string, TrustResult>();

function projectRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function checkGithubTrust(): TrustResult {
  const slug = parseRepoSlug();
  if (!slug) {
    return {
      level: 'unknown',
      reason: 'could not parse github repo slug from origin url',
      cache_ttl_seconds: 3600,
    };
  }

  // Try rulesets first (merge queue lives in a ruleset).
  try {
    const raw = execSync(`gh api repos/${slug}/rulesets`, { encoding: 'utf8' });
    const rulesets = JSON.parse(raw) as Array<{ id: number; enforcement?: string }>;
    for (const rs of rulesets) {
      try {
        const rsRaw = execSync(`gh api repos/${slug}/rulesets/${rs.id}`, {
          encoding: 'utf8',
        });
        const detail = JSON.parse(rsRaw) as { rules?: Array<{ type?: string }> };
        for (const rule of detail.rules ?? []) {
          if (rule.type === 'merge_queue') {
            return {
              level: 'pre_merge_authoritative',
              reason: 'github merge queue ruleset present',
              cache_ttl_seconds: 3600,
            };
          }
        }
      } catch {
        // continue
      }
    }
  } catch {
    // rulesets unavailable or API error — fall through
  }

  // Fall back to branch protection strict check.
  try {
    const raw = execSync(`gh api repos/${slug}/branches/main/protection`, {
      encoding: 'utf8',
    });
    const prot = JSON.parse(raw) as {
      required_status_checks?: { strict?: boolean };
    };
    if (prot.required_status_checks?.strict === true) {
      return {
        level: 'pre_merge_authoritative',
        reason: 'github branch protection strict=true on main',
        cache_ttl_seconds: 3600,
      };
    }
    return {
      level: 'post_merge_required',
      reason: 'github branch protection without strict mode',
      cache_ttl_seconds: 3600,
    };
  } catch {
    return {
      level: 'unknown',
      reason: 'github api call failed',
      cache_ttl_seconds: 3600,
    };
  }
}

function checkGitlabTrust(): TrustResult {
  // Detect project via glab api
  try {
    const info = gitlabApiRepo();
    // Only merge trains provide pre-merge authority
    if (info.merge_trains_enabled === true) {
      return {
        level: 'pre_merge_authoritative',
        reason: 'gitlab merge trains enabled',
        cache_ttl_seconds: 3600,
      };
    }
    // Merge pipelines alone are not sufficient - they still allow merge before CI completes
    return {
      level: 'post_merge_required',
      reason: 'gitlab without merge trains',
      cache_ttl_seconds: 3600,
    };
  } catch {
    return {
      level: 'unknown',
      reason: 'glab api call failed',
      cache_ttl_seconds: 3600,
    };
  }
}

function computeTrust(): TrustResult {
  const platform = detectPlatform();
  if (platform === 'github') return checkGithubTrust();
  if (platform === 'gitlab') return checkGitlabTrust();
  return {
    level: 'unknown',
    reason: 'unrecognized platform',
    cache_ttl_seconds: 3600,
  };
}

const waveCiTrustLevelHandler: HandlerDef = {
  name: 'wave_ci_trust_level',
  description: 'Detect whether the platform guarantees pre-merge CI == post-merge CI',
  inputSchema,
  async execute(rawArgs: unknown) {
    try {
      inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const key = projectRoot();
      let result = cache.get(key);
      if (!result) {
        result = computeTrust();
        cache.set(key, result);
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, ...result }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

// Exported for tests to reset cache between cases.
export function __resetCache() {
  cache.clear();
}

export default waveCiTrustLevelHandler;
