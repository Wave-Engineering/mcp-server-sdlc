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
//
// Durable-state fallback (#415): the bus directory under
// `body_artifacts_dir` is wiped by `wave_complete` per-wave cleanup. If the
// finalize handler is reached after the LAST wave has cleaned up, the bus
// returns zero entries and we would emit `no_artifacts`. To survive that,
// `assembleBodyFromState` re-derives the body from
// `<project>/.claude/status/{phases-waves.json,state.json}` (or the .sdlc/
// equivalent), which are persisted across wave cleanup. The handler tries
// the bus first and falls back to durable state when the bus is empty.

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

/**
 * Extract the free-text slug suffix from `<prefix>/<id>-<slug>`.
 *
 * The prefix used to be pinned to `kahuna` (#503). Post-claudecode-workflow#1052
 * an integration branch can also be a `campaign/<planId>-<slug>`, and a caller may
 * supply any name via `wave_init`'s `kahuna.branch` — against which the pinned
 * pattern returned `''` and silently degraded the MR title to
 * `plan(#56):  — kahuna to …`. Any single-segment prefix is accepted now; the
 * only structural requirement is the `<digits>-` that separates the id from the
 * slug. Still `''` for a branch with no slug segment — the caller renders that as
 * an empty slug rather than inventing one.
 */
export function epicSlugFromBranch(kahunaBranch: string): string {
  const m = /^[^/]+\/\d+-(.+)$/.exec(kahunaBranch);
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

// ---------------------------------------------------------------------------
// Durable-state fallback (#415)
// ---------------------------------------------------------------------------
//
// `wave_complete` wipes the per-wave bus dir (the directory `assembleBody`
// reads from). After the LAST wave's cleanup, the bus is gone but
// `phases-waves.json` (plan structure: phases→waves→issues) and `state.json`
// (`waves[wave_id].mr_urls` mapping issue#→PR URL) survive — they are
// rewritten in place by the wave-status CLI, never deleted by the per-wave
// cleanup. `assembleBodyFromState` re-derives the MR body from those two
// files so finalize succeeds after cleanup.

/** Resolve the wave-status state directory used by the project — see
 *  `lib/wave_init_plan.ts:statusDir` and `lib/wave_reconcile_mrs_plan.ts`
 *  for the authoritative pair. We keep this resolver separate to avoid
 *  importing those modules (and the platform-adapter they pull in) into a
 *  pure-helper file. */
async function resolveStatusDir(root: string): Promise<string> {
  const sdlc = join(root, '.sdlc');
  if (await Bun.file(sdlc).exists()) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

interface DurablePlanIssue { number: number }
interface DurablePlanWave { id?: string; issues?: DurablePlanIssue[] }
interface DurablePlanPhase { waves?: DurablePlanWave[] }
interface DurablePlanData { phases?: DurablePlanPhase[] }

interface DurableWaveState { mr_urls?: Record<string, string> }
interface DurableStateData {
  waves?: Record<string, DurableWaveState>;
  current_wave?: string | null;
}

/**
 * Re-derive the kahuna→target MR body from durable wave-status state when
 * the bus directory has been cleaned. Returns `issueCount: 0` when the
 * state files are absent or the plan contains no issues — caller decides
 * whether to surface `no_artifacts` after this fallback also fails.
 *
 * The body shape mirrors `assembleBody`:
 *   - one `### <wave-id>` heading per wave that has issues
 *   - one bullet per issue, with a `[PR](url) — ` prefix when state has an
 *     mr_url for that issue
 *
 * Per-flight grouping is intentionally collapsed: `state.json` records
 * mr_urls keyed by issue#, NOT by flight, so we cannot reconstruct the
 * flight partition. The wave-level grouping is enough to honor AC-2 ("one
 * bullet per flight as before") in the practical case where each issue is
 * its own flight; multi-issue flights will appear as flat per-issue
 * bullets under the wave heading. This is a deliberate trade-off — durable
 * state is the only source surviving cleanup, and capturing flight ids
 * there is out of scope for #415.
 */
export async function assembleBodyFromState(
  projectRoot: string,
  epicId: number,
  kahunaBranch: string,
  targetBranch: string,
): Promise<AssembleResult> {
  const dir = await resolveStatusDir(projectRoot);
  const planPath = join(dir, 'phases-waves.json');
  const statePath = join(dir, 'state.json');

  const emptyResult: AssembleResult = { body: '', issueCount: 0, flightCount: 0 };
  let plan: DurablePlanData;
  let state: DurableStateData;
  try {
    if (!(await Bun.file(planPath).exists()) || !(await Bun.file(statePath).exists())) {
      return emptyResult;
    }
    plan = (await Bun.file(planPath).json()) as DurablePlanData;
    state = (await Bun.file(statePath).json()) as DurableStateData;
  } catch {
    return emptyResult;
  }

  const lines: string[] = [];
  lines.push(`Epic #${epicId} — integration branch \`${kahunaBranch}\` ready for merge into \`${targetBranch}\`.`);
  lines.push('');
  lines.push('## Waves');

  let issueCount = 0;
  const waveSet = new Set<string>();

  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      const waveId = wave.id ?? '';
      const issues = wave.issues ?? [];
      if (waveId.length === 0 || issues.length === 0) continue;

      const mrUrls = state.waves?.[waveId]?.mr_urls ?? {};
      lines.push('');
      lines.push(`### ${waveId}`);
      waveSet.add(waveId);

      // Sort issues by number for stable output.
      const sortedIssues = [...issues].sort((a, b) => a.number - b.number);
      for (const issue of sortedIssues) {
        const url = mrUrls[String(issue.number)];
        const prefix = url !== undefined && url.length > 0 ? `[PR](${url}) — ` : '';
        lines.push(`- Issue #${issue.number}: ${prefix}`.trimEnd().replace(/ — $/, ''));
        issueCount++;
      }
    }
  }

  if (issueCount === 0) return emptyResult;
  // `flightCount` from durable state can't distinguish flights — surface
  // wave count instead. Callers use issueCount for the no_artifacts gate;
  // flightCount is only logged.
  return { body: lines.join('\n'), issueCount, flightCount: waveSet.size };
}
