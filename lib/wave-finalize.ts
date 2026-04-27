// Wave-finalize platform-agnostic helpers — artifact tree walker, body
// composition, SHA hashing, and path containment. Extracted from
// `handlers/wave_finalize.ts` per Story 2.23 (#317) so the handler shell
// stays ≤80 lines and contains no platform branching or direct subprocess
// invocation.
//
// See claudecode-workflow:docs/kahuna-devspec.md §5.1.1 for the authoritative
// contract.
//
// File reads + directory walks use Bun native APIs (Bun.Glob + Bun.file)
// instead of node:fs. Sibling test files partially mock 'fs' (only
// writeFileSync), and Bun's mock.module leaks across the entire suite —
// any handler importing readFileSync/readdirSync from 'fs' or 'node:fs' gets
// `undefined` if the offending test runs first. See lesson_mcp_gotchas.md §6.

import { createHash } from 'crypto';
import { join, resolve } from 'path';

export function projectDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * Default wavebus artifact dir. The wavebus skill writes to
 * `/tmp/wavemachine/<repo-slug>/` — we approximate with the epic slug
 * extracted from the kahuna branch name. Callers can pass an explicit
 * `body_artifacts_dir` to override.
 */
export function defaultArtifactsDir(kahunaBranch: string): string {
  const m = /^kahuna\/(.+)$/.exec(kahunaBranch);
  const slug = m !== null ? m[1] : kahunaBranch.replace(/\//g, '-');
  return `/tmp/wavemachine/${slug}`;
}

/**
 * Contain `body_artifacts_dir` to safe locations. The handler reads every
 * results.md and merge-report.md under this directory into the MR body, so an
 * unchecked path would let a caller exfiltrate arbitrary file contents into a
 * PR description (and its SHA). Resolution rules:
 *   - If not explicitly supplied, the default `/tmp/wavemachine/<slug>/` is
 *     trusted unconditionally.
 *   - If explicit, the resolved absolute path must be under `/tmp/` or under
 *     the caller's project directory. Anything else is rejected.
 */
export function resolveArtifactsDir(
  explicit: string | undefined,
  defaultPath: string,
  projectRoot: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (explicit === undefined || explicit.length === 0) {
    return { ok: true, path: defaultPath };
  }
  const absolute = resolve(explicit);
  const projectAbs = resolve(projectRoot);
  if (
    absolute.startsWith('/tmp/') ||
    absolute === '/tmp' ||
    absolute === projectAbs ||
    absolute.startsWith(`${projectAbs}/`)
  ) {
    return { ok: true, path: absolute };
  }
  return {
    ok: false,
    error: `body_artifacts_dir '${explicit}' resolves outside allowed roots (/tmp or project directory)`,
  };
}

/** Extract the free-text slug suffix from `kahuna/<epic_id>-<slug>`. */
export function epicSlugFromBranch(kahunaBranch: string): string {
  const m = /^kahuna\/\d+-(.+)$/.exec(kahunaBranch);
  return m !== null ? m[1] : '';
}

async function readIfExists(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return await file.text();
  } catch {
    return null;
  }
}

function extractMrUrl(content: string): string | undefined {
  const m = /https?:\/\/[^\s)"']+\/(?:pull|merge_requests)\/\d+/.exec(content);
  return m !== null ? m[0] : undefined;
}

function extractSummary(content: string): string {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    return line.replace(/^[-*]\s*/, '').slice(0, 240);
  }
  return '';
}

export interface AssembleResult {
  body: string;
  issueCount: number;
  flightCount: number;
}

interface ResolvedEntry {
  wave: string;
  flight: string;
  issueId?: string;
  resultsRel: string; // path relative to artifactsDir
}

/** Sort `wave-N` / `flight-N` / `issue-N` lexicographically with numeric awareness. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Walks the canonical wavebus layout:
 *   artifactsDir / wave-N / flight-M / issue-X / results.md
 * and composes a markdown body grouping entries by wave and flight. Each
 * per-issue bullet links to the flight's PR/MR when the URL is recoverable
 * from the artifact (from results.md directly or from the flight's
 * `merge-report.md`).
 *
 * Silently falls back to a flatter layout where the devspec describes
 * `flight-M/results.md` with no issue-X sub-directory — keeps the handler
 * resilient to artifact-layout drift.
 */
export async function assembleBody(
  artifactsDir: string,
  epicId: number,
  kahunaBranch: string,
  targetBranch: string,
): Promise<AssembleResult> {
  // Bun.Glob.scanSync walks the tree without going through `'fs'`, so it is
  // immune to the partial `mock.module('fs', ...)` leakage.
  const issueGlob = new Bun.Glob('wave-*/flight-*/issue-*/results.md');
  const flatGlob = new Bun.Glob('wave-*/flight-*/results.md');

  // Bun.Glob.scanSync throws ENOENT when the cwd doesn't exist (legitimate
  // case — e.g. the default `/tmp/wavemachine/<slug>/` may never have been
  // created if the wave was run elsewhere). Treat as "no entries".
  function safeScan(glob: Bun.Glob): string[] {
    try {
      return Array.from(glob.scanSync({ cwd: artifactsDir, onlyFiles: true }));
    } catch {
      return [];
    }
  }

  const entries: ResolvedEntry[] = [];
  for (const rel of safeScan(issueGlob)) {
    const parts = rel.split('/');
    if (parts.length === 4) {
      entries.push({
        wave: parts[0],
        flight: parts[1],
        issueId: parts[2].replace(/^issue-/, ''),
        resultsRel: rel,
      });
    }
  }
  // Only consider the flat layout when no issue-* entries are found at all
  // — mixing the two would produce confusing output.
  if (entries.length === 0) {
    for (const rel of safeScan(flatGlob)) {
      const parts = rel.split('/');
      if (parts.length === 3) {
        entries.push({ wave: parts[0], flight: parts[1], resultsRel: rel });
      }
    }
  }

  entries.sort((a, b) => {
    const w = naturalCompare(a.wave, b.wave);
    if (w !== 0) return w;
    const f = naturalCompare(a.flight, b.flight);
    if (f !== 0) return f;
    if (a.issueId !== undefined && b.issueId !== undefined) {
      return naturalCompare(a.issueId, b.issueId);
    }
    return 0;
  });

  const lines: string[] = [];
  lines.push(`Epic #${epicId} — integration branch \`${kahunaBranch}\` ready for merge into \`${targetBranch}\`.`);
  lines.push('');
  lines.push('## Waves');

  // Cache merge-report.md URL maps per (wave, flight) so we don't reread them
  // for each issue in the same flight.
  const mergeReportCache = new Map<string, Map<string, string>>();
  async function urlsForFlight(wave: string, flight: string): Promise<Map<string, string>> {
    const key = `${wave}/${flight}`;
    const cached = mergeReportCache.get(key);
    if (cached !== undefined) return cached;
    const content = (await readIfExists(join(artifactsDir, wave, flight, 'merge-report.md'))) ?? '';
    const urls = new Map<string, string>();
    for (const m of content.matchAll(/issue[-_ ]*#?(\d+)[^\n]*?(https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+)/gi)) {
      urls.set(m[1], m[2]);
    }
    mergeReportCache.set(key, urls);
    return urls;
  }

  let currentWave = '';
  let currentFlight = '';
  const flightSet = new Set<string>();
  let issueCount = 0;

  for (const entry of entries) {
    if (entry.wave !== currentWave) {
      lines.push('');
      lines.push(`### ${entry.wave}`);
      currentWave = entry.wave;
      currentFlight = '';
    }
    if (entry.flight !== currentFlight) {
      lines.push('');
      lines.push(`#### ${entry.flight}`);
      currentFlight = entry.flight;
      flightSet.add(`${entry.wave}/${entry.flight}`);
    }

    const content = (await readIfExists(join(artifactsDir, entry.resultsRel))) ?? '';
    let mrUrl = extractMrUrl(content);
    if (mrUrl === undefined && entry.issueId !== undefined) {
      mrUrl = (await urlsForFlight(entry.wave, entry.flight)).get(entry.issueId);
    }
    const summary = extractSummary(content);
    const mrLink = mrUrl !== undefined ? `[PR](${mrUrl}) — ` : '';

    if (entry.issueId !== undefined) {
      issueCount++;
      const bullet = summary.length > 0 ? `${mrLink}${summary}` : mrLink.replace(/ — $/, '');
      lines.push(`- Issue #${entry.issueId}: ${bullet}`.trimEnd());
    } else {
      issueCount++;
      lines.push(`- ${mrLink}${summary}`.trimEnd());
    }
  }

  return { body: lines.join('\n'), issueCount, flightCount: flightSet.size };
}

/** SHA-256 hex digest of the assembled body for drift detection. */
export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
