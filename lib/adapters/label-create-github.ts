/**
 * GitHub `label_create` adapter implementation.
 *
 * Lifted from `handlers/label_create.ts` per Story 2.15 (#309). The handler
 * is now a thin dispatcher; this module owns the GitHub-specific subprocess
 * work (argv composition + `gh label create` invocation) AND the
 * idempotent-duplicate-lookup retry that swallows "already exists" into a
 * `created: false` success.
 *
 * Argv composition (create):
 *   gh label create <name>
 *     [--description <description>]
 *     [--color <bare-hex>]      // gh accepts bare 6-char hex (no leading `#`)
 *     [--repo <owner/repo>]
 *
 * Argv composition (duplicate-lookup fallback):
 *   gh label list --search <name> --json name,description,color --limit 20
 *     [--repo <owner/repo>]
 *
 * Color asymmetry (per `lesson_origin_ops_pitfalls.md`):
 *   - GitHub: bare hex `RRGGBB` — no leading `#`. gh REJECTS `#RRGGBB`.
 *   - GitLab: leading `#RRGGBB` — GitLab REST API REJECTS bare hex.
 *   The handler's schema accepts bare hex (consumer-symmetric); the GitLab
 *   adapter prepends the `#` before handing off to `glab`.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  LabelCreateArgs,
  NormalizedLabel,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * gh reports "label already exists" on the duplicate path. Heuristic match —
 * phrasing varies across CLI versions but consistently includes the substring
 * "already exists". Case-insensitive — "Already Exists" seen in the wild too.
 */
function stderrIndicatesDuplicate(text: string): boolean {
  return /already exists/i.test(text);
}

function lookupGithubLabel(
  name: string,
  repo: string | undefined,
  cwd: string,
): NormalizedLabel | null {
  const cmd = ['gh', 'label', 'list', '--search', name, '--json', 'name,description,color', '--limit', '20'];
  if (repo !== undefined) cmd.push('--repo', repo);
  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0) return null;
  try {
    const labels = JSON.parse(result.stdout) as Array<{ name: string; description?: string; color?: string }>;
    // gh label list --search is a fuzzy match; pick the exact case-insensitive name.
    const match = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) return null;
    return {
      name: match.name,
      description: match.description ?? '',
      color: match.color ?? '',
      created: false,
    };
  } catch {
    return null;
  }
}

export async function labelCreateGithub(
  args: LabelCreateArgs,
): Promise<AdapterResult<NormalizedLabel>> {
  try {
    const cwd = projectDir();
    const description = args.description ?? '';

    const cmd = ['gh', 'label', 'create', args.name];
    if (description.length > 0) cmd.push('--description', description);
    if (args.color !== undefined) cmd.push('--color', args.color);
    if (args.repo !== undefined) cmd.push('--repo', args.repo);

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      const combined = `${result.stderr}\n${result.stdout}`;
      if (stderrIndicatesDuplicate(combined)) {
        const existing = lookupGithubLabel(args.name, args.repo, cwd);
        if (existing !== null) return { ok: true, data: existing };
        return {
          ok: false,
          code: 'gh_label_lookup_failed',
          error: `gh label create: label '${args.name}' already exists but could not be found via lookup`,
        };
      }
      return {
        ok: false,
        code: 'gh_label_create_failed',
        error: `gh label create failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    return {
      ok: true,
      data: {
        name: args.name,
        description,
        color: args.color ?? '',
        created: true,
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

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls without needing access to the handler's mock setup.
void execSync;
