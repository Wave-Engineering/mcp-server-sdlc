/**
 * Resolve the authenticated GitLab user's username via `glab api /user` (#577).
 *
 * Used to self-assign MRs at creation: `glab mr create --assignee <username>`.
 * glab's `--assignee` takes usernames (not gh's server-resolved `@me`), so the
 * current user must be resolved first. No `--jq` flag (glab 1.36.0 rejects it) —
 * parse the JSON in-process, per `lesson_origin_ops_pitfalls`.
 *
 * NON-FATAL BY DESIGN: returns `null` on any failure (glab unauthed, network,
 * malformed JSON) so a self-assign *convenience* never blocks MR creation. The
 * caller omits `--assignee` when this is null and creates the MR unassigned.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export function resolveGitlabSelfSync(cwd?: string): string | null {
  const dir = cwd ?? projectDir();
  const result = runArgv(['glab', 'api', '/user'], dir);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { username?: unknown };
    return typeof parsed.username === 'string' && parsed.username.length > 0
      ? parsed.username
      : null;
  } catch {
    return null;
  }
}

// `execSync` is intentionally re-imported above so adapter-level test files can
// `mock.module('child_process', ...)` and intercept this module's subprocess
// calls. See resolve-default-branch-gitlab.ts for the rationale.
void execSync;
