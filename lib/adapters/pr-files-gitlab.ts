/**
 * GitLab `pr_files` adapter implementation.
 *
 * Lifted from `handlers/pr_files.ts` per Story 1.5. Mirrors `pr-files-github.ts`
 * — the handler dispatches to either depending on cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - There is no `glab` CLI subcommand that returns per-file additions/deletions.
 *   We fetch the MR via `gitlabApiMr` (per Dev Spec §5.3 — `lib/glab.ts` stays
 *   as the shared GitLab REST client) and parse hunk stats from each
 *   change's unified `diff` field.
 * - File status (added/modified/removed/renamed) is derived from the boolean
 *   flags on each `change` (`new_file`/`renamed_file`/`deleted_file`) rather
 *   than a single `changeType` enum like GitHub provides.
 *
 * `parseDiffStats` and `mapGitlabStatus` are tiny single-consumer helpers —
 * they stay inline here. `parseDiffStats` is also re-exported from
 * `handlers/pr_files.ts` (via shim) to preserve the integration test's
 * existing import surface.
 */

import { execSync } from 'child_process';
import { gitlabApiMr } from '../glab.js';
import type {
  AdapterResult,
  PrFilesArgs,
  PrFilesEntry,
  PrFilesResponse,
  PrFilesStatus,
} from './types.js';

interface GitlabChange {
  new_path?: string;
  old_path?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string;
}

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

/**
 * Parse a unified-diff hunk string and return additions/deletions.
 * Additions are lines starting with a single '+' (not '+++').
 * Deletions are lines starting with a single '-' (not '---').
 * Hunk headers (@@) and context lines are ignored.
 */
export function parseDiffStats(diff: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function mapGitlabStatus(change: GitlabChange): PrFilesStatus {
  if (change.new_file) return 'added';
  if (change.deleted_file) return 'removed';
  if (change.renamed_file) return 'renamed';
  return 'modified';
}

export async function prFilesGitlab(
  args: PrFilesArgs,
): Promise<AdapterResult<PrFilesResponse>> {
  try {
    const mr = gitlabApiMr(args.number, parseSlugOpts(args.repo)) as unknown as {
      changes?: GitlabChange[];
    };
    const changes = mr.changes ?? [];
    const files: PrFilesEntry[] = changes.map((c) => {
      const path = c.new_path ?? c.old_path ?? '';
      const status = mapGitlabStatus(c);
      const { additions, deletions } = parseDiffStats(c.diff ?? '');
      return { path, status, additions, deletions };
    });

    const total_additions = files.reduce((sum, f) => sum + f.additions, 0);
    const total_deletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return {
      ok: true,
      data: {
        number: args.number,
        files,
        total_additions,
        total_deletions,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See pr-files-github.ts for the rationale.
void execSync;
