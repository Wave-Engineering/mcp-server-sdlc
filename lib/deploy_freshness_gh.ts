/**
 * The real GitHub-backed FreshnessDeps for #447. Kept apart from the pure logic
 * in deploy_freshness.ts so the logic is testable without touching a subprocess.
 *
 * TRULY ASYNC, and this matters. The check fires at startup, in the same window
 * the MCP client sends `initialize`. The rest of the server shells out with the
 * SYNCHRONOUS `execSync` (fine inside a tool call, which is already blocking), but
 * here that would freeze the event loop across two `gh api` round-trips and stall
 * the handshake — and with no timeout, a black-holed network would hang the server
 * for as long as the OS lets a TCP connect stall. So this uses `execFile` (async,
 * no shell) with a bounded timeout: the event loop keeps turning, and every
 * failure — missing `gh`, non-zero exit, timeout, offline — resolves to null.
 */

import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import type { CompareStatus, FreshnessDeps } from './deploy_freshness.js';
import { SELF_REPO } from './deploy_freshness.js';

// Bound each call so a hung network cannot delay the server indefinitely.
const GH_TIMEOUT_MS = 5000;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/** Run `gh <args>` async; null on ANY failure (exit≠0, timeout, ENOENT, …). */
async function ghApi(args: string[]): Promise<string | null> {
  try {
    const execFileAsync = promisify(childProcess.execFile);
    const { stdout } = await execFileAsync('gh', args, {
      cwd: projectDir(),
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const VALID_STATUS = new Set<CompareStatus>([
  'ahead',
  'behind',
  'identical',
  'diverged',
]);

export const ghFreshnessDeps: FreshnessDeps = {
  async fetchLatestReleaseTag(): Promise<string | null> {
    return ghApi(['api', `repos/${SELF_REPO}/releases/latest`, '--jq', '.tag_name']);
  },

  async compareRefs(base: string, head: string): Promise<CompareStatus | null> {
    // encodeURIComponent guards the path even though both args are our own
    // (a 40-hex SHA and a release tag) — defense at the boundary.
    const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const status = await ghApi(['api', `repos/${SELF_REPO}/compare/${range}`, '--jq', '.status']);
    return status !== null && VALID_STATUS.has(status as CompareStatus)
      ? (status as CompareStatus)
      : null;
  },
};
