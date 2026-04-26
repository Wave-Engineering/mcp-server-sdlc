/**
 * GitHub `label_list` adapter implementation.
 *
 * Lifted from `handlers/label_list.ts` per Story 2.16 (#310). The handler is
 * now a thin dispatcher; this module owns the GitHub-specific subprocess work
 * (argv composition + `gh label list` invocation) and the bare-hex
 * color-normalization (gh already emits bare hex, so the transform is an
 * identity pass — kept explicit for symmetry with the GitLab adapter).
 *
 * Argv composition:
 *   gh label list
 *     --json name,description,color
 *     --limit <N>
 *     [--repo <owner/repo>]
 *
 * Color asymmetry (per `lesson_origin_ops_pitfalls.md`):
 *   - GitHub: bare hex `RRGGBB` — gh returns color without a leading `#`.
 *   - GitLab: leading `#RRGGBB` — glab returns color with a leading `#`;
 *     `label-list-gitlab.ts` strips it so consumers always see bare hex.
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

interface GithubLabel {
  name: string;
  description?: string;
  color?: string;
}

export async function labelListGithub(
  args: LabelListArgs,
): Promise<AdapterResult<LabelListResponse>> {
  try {
    const cwd = projectDir();

    const cmd = ['gh', 'label', 'list', '--json', 'name,description,color', '--limit', String(args.limit)];
    if (args.repo !== undefined) cmd.push('--repo', args.repo);

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_label_list_failed',
        error: `gh label list failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    let parsed: GithubLabel[];
    try {
      parsed = JSON.parse(result.stdout) as GithubLabel[];
    } catch (err) {
      return {
        ok: false,
        code: 'gh_label_list_parse_failed',
        error: `gh label list: failed to parse JSON — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const labels: NormalizedLabelListEntry[] = parsed.map((l) => ({
      name: l.name,
      description: l.description ?? '',
      // gh emits bare hex already; identity pass kept for symmetry with glab path.
      color: l.color ?? '',
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

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls without needing access to the handler's mock setup.
void execSync;
