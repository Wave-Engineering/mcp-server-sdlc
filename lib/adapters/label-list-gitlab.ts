/**
 * GitLab `label_list` adapter implementation.
 *
 * Lifted from `handlers/label_list.ts` per Story 2.16 (#310). Mirrors
 * `label-list-github.ts` — the handler dispatches to either depending on cwd
 * platform.
 *
 * Argv composition:
 *   glab label list
 *     -F json
 *     --per-page <N>
 *     [-R <owner/repo>]        // glab uses short `-R`, NOT `--repo`
 *
 * Color asymmetry (per `lesson_origin_ops_pitfalls.md`):
 *   - GitHub: bare hex `RRGGBB` — gh returns without a leading `#`.
 *   - GitLab: leading `#RRGGBB` — glab returns with a leading `#`; we strip it
 *     so consumers always see bare hex (symmetric with gh path).
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  LabelListArgs,
  LabelListResponse,
  NormalizedLabelListEntry,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

interface GitlabLabel {
  name: string;
  description?: string;
  // `glab label list -F json` returns `color` as `#RRGGBB` (with leading `#`).
  color?: string;
}

export async function labelListGitlab(
  args: LabelListArgs,
): Promise<AdapterResult<LabelListResponse>> {
  try {
    const cwd = projectDir();

    const cmd = ['glab', 'label', 'list', '-F', 'json', '--per-page', String(args.limit)];
    if (args.repo !== undefined) cmd.push('-R', args.repo);

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_label_list_failed',
        error: `glab label list failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    let parsed: GitlabLabel[];
    try {
      parsed = JSON.parse(result.stdout) as GitlabLabel[];
    } catch (err) {
      return {
        ok: false,
        code: 'glab_label_list_parse_failed',
        error: `glab label list: failed to parse JSON — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const labels: NormalizedLabelListEntry[] = parsed.map((l) => ({
      name: l.name,
      description: l.description ?? '',
      // Strip leading `#` — consumers always see bare hex (symmetric with gh path).
      color: (l.color ?? '').replace(/^#/, ''),
    }));

    return { ok: true, data: { labels, count: labels.length } };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See label-list-github.ts for the rationale.
void execSync;
