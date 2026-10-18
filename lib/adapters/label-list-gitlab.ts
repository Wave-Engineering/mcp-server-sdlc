/**
 * GitLab `label_list` adapter implementation.
 *
 * Lifted from `handlers/label_list.ts` per Story 2.16 (#310). Mirrors
 * `label-list-github.ts` — the handler dispatches to either depending on cwd
 * platform.
 *
 * Argv composition:
 *   glab api projects/<:id | url-encoded owner/repo>/labels?per_page=<N>
 *
 * `glab api`, not `glab label list -F json`: `label list` has no `-F`/`--output`
 * before glab 1.37.0, one release above the documented 1.36.0 floor (#594).
 * The REST response is the same label objects `label list -F json` printed.
 *
 * Color asymmetry (per `lesson_origin_ops_pitfalls.md`):
 *   - GitHub: bare hex `RRGGBB` — gh returns without a leading `#`.
 *   - GitLab: leading `#RRGGBB` — glab returns with a leading `#`; we strip it
 *     so consumers always see bare hex (symmetric with gh path).
 */

import { execSync } from 'child_process';
import { detectGlabApiError } from '../gitlab-api.js';
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
  // The REST API returns `color` as `#RRGGBB` (with leading `#`).
  color?: string;
}

export async function labelListGitlab(
  args: LabelListArgs,
): Promise<AdapterResult<LabelListResponse>> {
  try {
    const cwd = projectDir();

    const projectId = args.repo !== undefined ? encodeURIComponent(args.repo) : ':id';
    const cmd = ['glab', 'api', `projects/${projectId}/labels?per_page=${String(args.limit)}`];

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_label_list_failed',
        error: `glab label list failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    // `glab api` exits 0 on an HTTP error and prints the error body (#502).
    const apiError = detectGlabApiError(result.stdout);
    if (apiError !== undefined) {
      return {
        ok: false,
        code: 'glab_label_list_failed',
        error: `glab label list failed: ${apiError}`,
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
