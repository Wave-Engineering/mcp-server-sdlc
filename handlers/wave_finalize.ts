// KAHUNA epic-final gate: opens the kahuna → main MR once all waves of an
// epic have landed in the kahuna integration branch. Idempotent — a second
// call for the same (kahuna_branch, target_branch) pair returns the existing
// open MR rather than creating a duplicate.
//
// See claudecode-workflow:docs/kahuna-devspec.md §5.1.1 for the authoritative
// contract.

import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/glab.js';

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

function listDirs(path: string): string[] {
  try {
    return readdirSync(path).filter((name) => {
      try {
        return statSync(join(path, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
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
function assembleBody(
  artifactsDir: string,
  epicId: number,
  kahunaBranch: string,
  targetBranch: string,
): AssembleResult {
  const waves = listDirs(artifactsDir)
    .filter((d) => d.startsWith('wave-'))
    .sort();

  const lines: string[] = [];
  lines.push(`Epic #${epicId} — integration branch \`${kahunaBranch}\` ready for merge into \`${targetBranch}\`.`);
  lines.push('');
  lines.push('## Waves');

  let flightCount = 0;
  let issueCount = 0;

  for (const wave of waves) {
    const wavePath = join(artifactsDir, wave);
    const flights = listDirs(wavePath).filter((d) => d.startsWith('flight-')).sort();
    if (flights.length === 0) continue;
    lines.push('');
    lines.push(`### ${wave}`);

    for (const flight of flights) {
      flightCount++;
      const flightPath = join(wavePath, flight);
      lines.push('');
      lines.push(`#### ${flight}`);

      const issues = listDirs(flightPath).filter((d) => d.startsWith('issue-')).sort();
      if (issues.length > 0) {
        const mergeReport = readIfExists(join(flightPath, 'merge-report.md')) ?? '';
        const mergeReportUrls = new Map<string, string>();
        // Best-effort correlation: line-level scan for "issue-X" paired with a PR/MR URL.
        for (const m of mergeReport.matchAll(/issue[-_ ]*#?(\d+)[^\n]*?(https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+)/gi)) {
          mergeReportUrls.set(m[1], m[2]);
        }
        for (const issueDir of issues) {
          issueCount++;
          const issueId = issueDir.replace(/^issue-/, '');
          const results = readIfExists(join(flightPath, issueDir, 'results.md')) ?? '';
          const mrUrl = extractMrUrl(results) ?? mergeReportUrls.get(issueId);
          const summary = extractSummary(results);
          const mrLink = mrUrl !== undefined ? `[PR](${mrUrl}) — ` : '';
          const bullet = summary.length > 0 ? `${mrLink}${summary}` : mrLink.replace(/ — $/, '');
          lines.push(`- Issue #${issueId}: ${bullet}`.trimEnd());
        }
      } else {
        // Flatter shape: flight-*/results.md directly (per devspec wording).
        const results = readIfExists(join(flightPath, 'results.md'));
        if (results !== null) {
          issueCount++;
          const mrUrl = extractMrUrl(results);
          const summary = extractSummary(results);
          const mrLink = mrUrl !== undefined ? `[PR](${mrUrl}) — ` : '';
          lines.push(`- ${mrLink}${summary}`.trimEnd());
        }
      }
    }
  }

  return { body: lines.join('\n'), issueCount, flightCount };
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
        const { body, issueCount } = assembleBody(artifactsDir, args.epic_id, args.kahuna_branch, args.target_branch);
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

      const { body, issueCount } = assembleBody(artifactsDir, args.epic_id, args.kahuna_branch, args.target_branch);
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
