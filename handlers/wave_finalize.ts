// KAHUNA epic-final gate: opens the kahuna → main MR once all waves of an
// epic have landed in the kahuna integration branch. Idempotent — a second
// call for the same (kahuna_branch, target_branch) pair returns the existing
// open MR rather than creating a duplicate.
//
// See claudecode-workflow:docs/kahuna-devspec.md §5.1.1 for the authoritative
// contract.

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
// File reads + directory walks use Bun native APIs (Bun.Glob + Bun.file)
// instead of node:fs. Sibling test files partially mock 'fs' (only
// writeFileSync), and Bun's mock.module leaks across the entire suite —
// any handler importing readFileSync/readdirSync from 'fs' or 'node:fs' gets
// `undefined` if the offending test runs first. See lesson_mcp_gotchas.md §6.
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';

const inputSchema = z.object({
  root: z.string().optional(),
  epic_id: z.number().int().positive(),
  kahuna_branch: z.string().min(1),
  target_branch: z.string().min(1).default('main'),
  body_artifacts_dir: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

function projectDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * Default wavebus artifact dir. The wavebus skill writes to
 * `/tmp/wavemachine/<repo-slug>/` — we approximate with the epic slug
 * extracted from the kahuna branch name. Callers can pass an explicit
 * `body_artifacts_dir` to override.
 */
function defaultArtifactsDir(kahunaBranch: string): string {
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
function resolveArtifactsDir(
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
function epicSlugFromBranch(kahunaBranch: string): string {
  const m = /^kahuna\/\d+-(.+)$/.exec(kahunaBranch);
  return m !== null ? m[1] : '';
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, cwd: string): RunResult {
  try {
    const out = execSync(cmd, { encoding: 'utf8', cwd });
    return { ok: true, stdout: out.trim(), stderr: '' };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '') ?? '';
    const stdout = (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString() ?? '') ?? '';
    return { ok: false, stdout: stdout.trim(), stderr: stderr.trim() || e.message || '' };
  }
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

interface AssembleResult {
  body: string;
  issueCount: number;
  flightCount: number;
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

interface NormalizedMr {
  number: number;
  url: string;
  state: 'open';
  head: string;
  base: string;
}

function branchExistsOnRemote(cwd: string, branch: string): boolean {
  const out = run(`git ls-remote --heads origin ${shellEscape(branch)}`, cwd);
  if (!out.ok) return false;
  return out.stdout.length > 0;
}

function findExistingGithubPr(head: string, base: string, cwd: string): NormalizedMr | null {
  const cmd =
    `gh pr list --head ${shellEscape(head)} --base ${shellEscape(base)} ` +
    `--state open --json number,url,state,headRefName,baseRefName --limit 1`;
  const result = run(cmd, cwd);
  if (!result.ok) return null;
  try {
    const prs = JSON.parse(result.stdout) as Array<{
      number: number;
      url: string;
      state: string;
      headRefName: string;
      baseRefName: string;
    }>;
    if (prs.length === 0) return null;
    const pr = prs[0];
    return { number: pr.number, url: pr.url, state: 'open', head: pr.headRefName, base: pr.baseRefName };
  } catch {
    return null;
  }
}

function findExistingGitlabMr(head: string, base: string, cwd: string): NormalizedMr | null {
  const cmd =
    `glab mr list --source-branch ${shellEscape(head)} --target-branch ${shellEscape(base)} ` +
    `--state opened -F json -P 1`;
  const result = run(cmd, cwd);
  if (!result.ok) return null;
  try {
    const mrs = JSON.parse(result.stdout) as Array<{
      iid: number;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    }>;
    if (mrs.length === 0) return null;
    const mr = mrs[0];
    return { number: mr.iid, url: mr.web_url, state: 'open', head: mr.source_branch, base: mr.target_branch };
  } catch {
    return null;
  }
}

interface CreateArgs {
  title: string;
  body: string;
  base: string;
  head: string;
}

function createGithubPr(args: CreateArgs, cwd: string): NormalizedMr {
  const cmd =
    `gh pr create --title ${shellEscape(args.title)} --body ${shellEscape(args.body)} ` +
    `--base ${shellEscape(args.base)} --head ${shellEscape(args.head)}`;
  const result = run(cmd, cwd);
  if (!result.ok) {
    throw new Error(`gh pr create failed: ${result.stderr || result.stdout}`);
  }
  const url = result.stdout.split('\n').pop() ?? '';
  const numMatch = /\/pull\/(\d+)/.exec(url);
  if (numMatch === null) {
    throw new Error(`gh pr create: could not parse PR number from output: ${url}`);
  }
  return {
    number: parseInt(numMatch[1], 10),
    url: url.trim(),
    state: 'open',
    head: args.head,
    base: args.base,
  };
}

function createGitlabMr(args: CreateArgs, cwd: string): NormalizedMr {
  const cmd =
    `glab mr create --title ${shellEscape(args.title)} --description ${shellEscape(args.body)} ` +
    `--target-branch ${shellEscape(args.base)} --source-branch ${shellEscape(args.head)} --yes`;
  const result = run(cmd, cwd);
  if (!result.ok) {
    throw new Error(`glab mr create failed: ${result.stderr || result.stdout}`);
  }
  // Normalize by fetching the MR we just created.
  const view = run(`glab mr view ${shellEscape(args.head)} -F json`, cwd);
  if (!view.ok) {
    throw new Error(`glab mr view failed: ${view.stderr || view.stdout}`);
  }
  const parsed = JSON.parse(view.stdout) as {
    iid: number;
    web_url: string;
    source_branch: string;
    target_branch: string;
  };
  return {
    number: parsed.iid,
    url: parsed.web_url,
    state: 'open',
    head: parsed.source_branch,
    base: parsed.target_branch,
  };
}

const waveFinalizeHandler: HandlerDef = {
  name: 'wave_finalize',
  description:
    'Open (or return the existing) kahuna→target_branch MR for a KAHUNA epic. ' +
    'Idempotent on (kahuna_branch, target_branch). The MR body is assembled from wavebus artifacts under `body_artifacts_dir` (default: /tmp/wavemachine/<slug>/). ' +
    'Returns kahuna_branch_not_found if the branch is absent on the remote; no_artifacts if the artifact tree contains no flight results. ' +
    'body_sha is a SHA-256 digest of the assembled body for drift detection.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const cwd = projectDir(args.root);
      // NOTE: detectPlatform() runs `git remote get-url origin` from the
      // sdlc-server's own cwd — not necessarily `cwd` resolved from args.root.
      // For single-repo usage this is fine; for cross-repo KAHUNA workflows
      // where root points elsewhere, the server's launch directory and the
      // target project must be on the same platform. Matches the codebase
      // pattern (pr_create/pr_merge/ci_*).
      const platform = detectPlatform();
      const resolved = resolveArtifactsDir(
        args.body_artifacts_dir,
        defaultArtifactsDir(args.kahuna_branch),
        cwd,
      );
      if (!resolved.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: resolved.error }) }],
        };
      }
      const artifactsDir = resolved.path;

      // Idempotency first (per devspec §5.1.1 step 1). Cover the edge case
      // where the kahuna branch was deleted after the MR was opened — we
      // still want to return the existing open MR rather than failing on a
      // missing branch.
      const existing =
        platform === 'github'
          ? findExistingGithubPr(args.kahuna_branch, args.target_branch, cwd)
          : findExistingGitlabMr(args.kahuna_branch, args.target_branch, cwd);
      if (existing !== null) {
        // Compute body_sha from current artifacts for drift detection. Empty
        // sha when artifacts are absent — a legitimate post-cleanup state.
        const { body, issueCount } = await assembleBody(artifactsDir, args.epic_id, args.kahuna_branch, args.target_branch);
        const bodySha = issueCount > 0 ? createHash('sha256').update(body).digest('hex') : '';
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              number: existing.number,
              url: existing.url,
              state: existing.state,
              created: false,
              body_sha: bodySha,
            }),
          }],
        };
      }

      if (!branchExistsOnRemote(cwd, args.kahuna_branch)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'kahuna_branch_not_found' }) }],
        };
      }

      const { body, issueCount } = await assembleBody(artifactsDir, args.epic_id, args.kahuna_branch, args.target_branch);
      if (issueCount === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'no_artifacts' }) }],
        };
      }

      const slug = epicSlugFromBranch(args.kahuna_branch);
      const title = `epic(#${args.epic_id}): ${slug} — kahuna to ${args.target_branch}`;
      const bodySha = createHash('sha256').update(body).digest('hex');

      const created =
        platform === 'github'
          ? createGithubPr({ title, body, base: args.target_branch, head: args.kahuna_branch }, cwd)
          : createGitlabMr({ title, body, base: args.target_branch, head: args.kahuna_branch }, cwd);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            number: created.number,
            url: created.url,
            state: 'open',
            created: true,
            body_sha: bodySha,
          }),
        }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default waveFinalizeHandler;
