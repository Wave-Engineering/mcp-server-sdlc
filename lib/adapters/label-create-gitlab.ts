/**
 * GitLab `label_create` adapter implementation.
 *
 * Lifted from `handlers/label_create.ts` per Story 2.15 (#309). Mirrors
 * `label-create-github.ts` — the handler dispatches to either depending on
 * cwd platform.
 *
 * Argv composition (create):
 *   glab label create --name <name>
 *     [--description <description>]
 *     [--color '#<hex>']       // GitLab REST API requires leading `#`
 *     [-R <owner/repo>]        // glab uses short `-R`, NOT `--repo`
 *
 * Argv composition (duplicate-lookup fallback):
 *   glab label list -F json --per-page 100 [-R <owner/repo>]
 *
 * Color asymmetry (per `lesson_origin_ops_pitfalls.md`):
 *   - GitHub: bare hex `RRGGBB` — no leading `#`.
 *   - GitLab: leading `#RRGGBB` — GitLab REST API REJECTS bare hex.
 *   The handler's schema accepts bare hex (consumer-symmetric); we prepend
 *   the `#` here on hand-off to `glab`. The response strips `#` from the
 *   lookup payload so consumers always see bare hex.
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
 * glab reports "label already exists" on the duplicate path — same heuristic
 * as the GitHub adapter. Phrasing varies across CLI versions but consistently
 * includes the substring "already exists". Case-insensitive.
 */
function stderrIndicatesDuplicate(text: string): boolean {
  return /already exists/i.test(text);
}

function lookupGitlabLabel(
  name: string,
  repo: string | undefined,
  cwd: string,
): NormalizedLabel | null {
  const cmd = ['glab', 'label', 'list', '-F', 'json', '--per-page', '100'];
  if (repo !== undefined) cmd.push('-R', repo);
  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0) return null;
  try {
    const labels = JSON.parse(result.stdout) as Array<{ name: string; description?: string; color?: string }>;
    const match = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) return null;
    return {
      name: match.name,
      description: match.description ?? '',
      // Strip leading `#` — consumers always see bare hex (symmetric with gh path).
      color: (match.color ?? '').replace(/^#/, ''),
      created: false,
    };
  } catch {
    return null;
  }
}

export async function labelCreateGitlab(
  args: LabelCreateArgs,
): Promise<AdapterResult<NormalizedLabel>> {
  try {
    const cwd = projectDir();
    const description = args.description ?? '';

    const cmd = ['glab', 'label', 'create', '--name', args.name];
    if (description.length > 0) cmd.push('--description', description);
    if (args.color !== undefined) {
      // GitLab REST API requires `#RRGGBB`; bare hex is rejected.
      cmd.push('--color', `#${args.color}`);
    }
    if (args.repo !== undefined) cmd.push('-R', args.repo);

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      const combined = `${result.stderr}\n${result.stdout}`;
      if (stderrIndicatesDuplicate(combined)) {
        const existing = lookupGitlabLabel(args.name, args.repo, cwd);
        if (existing !== null) return { ok: true, data: existing };
        return {
          ok: false,
          code: 'glab_label_lookup_failed',
          error: `glab label create: label '${args.name}' already exists but could not be found via lookup`,
        };
      }
      return {
        ok: false,
        code: 'glab_label_create_failed',
        error: `glab label create failed: ${result.stderr.trim() || result.stdout.trim()}`,
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

// See label-create-github.ts for the rationale.
void execSync;
