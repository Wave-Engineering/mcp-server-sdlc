// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string().min(1, 'body must be a non-empty string'),
  // base is optional — when omitted, the handler queries the platform for
  // the repo's default branch. /scp + sibling skills can stop probing for
  // it themselves. See #159.
  base: z.string().min(1).optional(),
  head: z.string().optional(),
  draft: z.boolean().optional().default(false),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], cwd: string): RunResult {
  // Explicitly pass `env` so subprocess PATH reflects the current
  // `process.env.PATH` — Bun.spawnSync otherwise snapshots env at process
  // start, which breaks tests that inject fake gh/glab/git via PATH stubs.
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

// Platform detection from the project's git remote. The .claude-project.md
// approach was too fragile — a mention of "GitLab CI" in a GitHub project
// would misroute to glab. Use the git remote URL as the source of truth.
async function detectPlatform(cwd: string): Promise<'github' | 'gitlab'> {
  const remote = run(['git', 'remote', '-v'], cwd);
  const firstLine = remote.stdout.split('\n')[0] ?? '';
  if (/gitlab/i.test(firstLine)) return 'gitlab';
  return 'github';
}

function getCurrentBranch(cwd: string): string {
  const result = run(['git', 'branch', '--show-current'], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git branch --show-current failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Query the platform for the repo's default branch name. Used when the
 * caller omits `base` so /scp + sibling skills can stop probing for it
 * themselves (#159).
 *
 * GitHub: `gh repo view <slug?> --json defaultBranchRef --jq .defaultBranchRef.name`
 * GitLab: `glab api projects/<encoded> --jq .default_branch` (or `glab repo view`
 *         when no explicit slug is provided — the porcelain command resolves
 *         from the cwd's remote).
 */
function getDefaultBranch(
  platform: 'github' | 'gitlab',
  repo: string | undefined,
  cwd: string,
): string {
  if (platform === 'github') {
    const cmd = ['gh', 'repo', 'view'];
    if (repo !== undefined) cmd.push(repo);
    cmd.push('--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
    const result = run(cmd, cwd);
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new Error(
        `failed to resolve GitHub default branch: ${result.stderr.trim() || 'empty response'}`,
      );
    }
    return result.stdout.trim();
  }
  // GitLab — `glab repo view` doesn't expose default_branch reliably across
  // versions; the API path does. Use `glab api projects/<encoded>` when an
  // explicit slug is provided, fall back to `:id` (which glab resolves from
  // the cwd remote) when not. NB: `glab api` has NO `--jq` flag (unlike
  // `gh api`); we parse the JSON in-process.
  const project = repo !== undefined ? repo.replace(/\//g, '%2F') : ':id';
  const result = run(['glab', 'api', `projects/${project}`], cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `failed to resolve GitLab default branch: ${result.stderr.trim() || 'empty response'}`,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout) as { default_branch?: string };
    if (typeof parsed.default_branch !== 'string' || parsed.default_branch.length === 0) {
      throw new Error('default_branch missing or empty in glab api response');
    }
    return parsed.default_branch;
  } catch (err) {
    throw new Error(
      `failed to resolve GitLab default branch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface NormalizedPr {
  number: number;
  url: string;
  state: 'open';
  head: string;
  base: string;
  created: boolean;
}

function lookupGithubPr(head: string, cwd: string, repo?: string): NormalizedPr | null {
  const cmd = ['gh', 'pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url,state,headRefName,baseRefName', '--limit', '1'];
  if (repo !== undefined) cmd.push('--repo', repo);
  const list = run(cmd, cwd);
  if (list.exitCode !== 0) return null;
  const prs = JSON.parse(list.stdout) as Array<{
    number: number;
    url: string;
    state: string;
    headRefName: string;
    baseRefName: string;
  }>;
  if (prs.length === 0) return null;
  return {
    number: prs[0].number,
    url: prs[0].url,
    state: 'open',
    head: prs[0].headRefName,
    base: prs[0].baseRefName,
    created: false,
  };
}

function createGithubPr(args: Input, head: string, cwd: string): NormalizedPr {
  // Caller guarantees base is resolved (default-branch lookup happens in
  // execute() before dispatch). Assert here to satisfy the type narrower —
  // a missing base at this point indicates a logic bug in the caller.
  if (args.base === undefined) {
    throw new Error('createGithubPr called without resolved base — caller bug');
  }
  const createCmd = [
    'gh',
    'pr',
    'create',
    '--title',
    args.title,
    '--body',
    args.body,
    '--base',
    args.base,
    '--head',
    head,
  ];
  if (args.draft) createCmd.push('--draft');
  if (args.repo !== undefined) createCmd.push('--repo', args.repo);

  const result = run(createCmd, cwd);
  if (result.exitCode !== 0) {
    const errText = (result.stderr + result.stdout).toLowerCase();
    // gh says "a pull request for branch ... already exists" on duplicate
    if (errText.includes('already exists')) {
      const existing = lookupGithubPr(head, cwd, args.repo);
      if (existing) return existing;
      // Lookup failed (PR may have been closed between create and lookup)
      throw new Error(`gh pr create: PR already exists for branch '${head}' but could not be found via lookup`);
    }
    throw new Error(`gh pr create failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  // gh pr create prints the PR URL on stdout. Parse the number from the URL.
  const url = result.stdout.trim().split('\n').pop() ?? '';
  const numMatch = /\/pull\/(\d+)/.exec(url);
  if (!numMatch) {
    throw new Error(`gh pr create: could not parse PR number from output: ${url}`);
  }
  const prNumber = parseInt(numMatch[1], 10);

  // Fetch canonical details to normalize the response.
  const viewCmd = ['gh', 'pr', 'view', String(prNumber), '--json', 'number,url,state,headRefName,baseRefName'];
  if (args.repo !== undefined) viewCmd.push('--repo', args.repo);
  const view = run(viewCmd, cwd);
  if (view.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${view.stderr.trim() || view.stdout.trim()}`);
  }
  const parsed = JSON.parse(view.stdout) as {
    number: number;
    url: string;
    state: string;
    headRefName: string;
    baseRefName: string;
  };
  return {
    number: parsed.number,
    url: parsed.url,
    state: 'open',
    head: parsed.headRefName,
    base: parsed.baseRefName,
    created: true,
  };
}

function lookupGitlabMr(head: string, cwd: string, repo?: string): NormalizedPr | null {
  const cmd = ['glab', 'mr', 'view', head, '-F', 'json'];
  if (repo !== undefined) cmd.push('-R', repo);
  const view = run(cmd, cwd);
  if (view.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(view.stdout) as {
      iid: number;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    };
    if (parsed.state !== 'opened') return null;
    return {
      number: parsed.iid,
      url: parsed.web_url,
      state: 'open',
      head: parsed.source_branch,
      base: parsed.target_branch,
      created: false,
    };
  } catch {
    return null;
  }
}

function createGitlabMr(args: Input, head: string, cwd: string): NormalizedPr {
  // Caller guarantees base is resolved — see comment in createGithubPr.
  if (args.base === undefined) {
    throw new Error('createGitlabMr called without resolved base — caller bug');
  }
  const createCmd = [
    'glab',
    'mr',
    'create',
    '--title',
    args.title,
    '--description',
    args.body,
    '--target-branch',
    args.base,
    '--source-branch',
    head,
    '--yes',
  ];
  if (args.draft) createCmd.push('--draft');
  if (args.repo !== undefined) createCmd.push('-R', args.repo);

  const result = run(createCmd, cwd);
  if (result.exitCode !== 0) {
    const errText = (result.stderr + result.stdout).toLowerCase();
    // glab says "Another open merge request already exists" on duplicate
    if (errText.includes('already exists')) {
      const existing = lookupGitlabMr(head, cwd, args.repo);
      if (existing) return existing;
      // Lookup failed (MR may have been closed between create and lookup)
      throw new Error(`glab mr create: MR already exists for branch '${head}' but could not be found via lookup`);
    }
    throw new Error(`glab mr create failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  // Normalize by fetching the MR we just created via `glab mr view <head> -F json`.
  const viewCmd = ['glab', 'mr', 'view', head, '-F', 'json'];
  if (args.repo !== undefined) viewCmd.push('-R', args.repo);
  const view = run(viewCmd, cwd);
  if (view.exitCode !== 0) {
    throw new Error(`glab mr view failed: ${view.stderr.trim() || view.stdout.trim()}`);
  }
  const parsed = JSON.parse(view.stdout) as {
    iid: number;
    web_url: string;
    state: string;
    source_branch: string;
    target_branch: string;
  };
  return {
    number: parsed.iid,
    url: parsed.web_url,
    state: 'open',
    head: parsed.source_branch,
    base: parsed.target_branch,
    created: true,
  };
}

const prCreateHandler: HandlerDef = {
  name: 'pr_create',
  description:
    'Create a pull request (GitHub) or merge request (GitLab) for the current branch. Returns the normalized {number, url, state, head, base}.',
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
      const cwd = projectDir();
      const head = args.head ?? getCurrentBranch(cwd);
      const platform = await detectPlatform(cwd);
      // Resolve `base` from the repo's default branch when omitted (#159).
      // `createGithub*/createGitlab*` both read from `args.base`, so we
      // mutate the parsed args in place — keeps both downstream paths simple.
      if (args.base === undefined || args.base.length === 0) {
        args.base = getDefaultBranch(platform, args.repo, cwd);
      }
      const pr =
        platform === 'github'
          ? createGithubPr(args, head, cwd)
          : createGitlabMr(args, head, cwd);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, ...pr }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default prCreateHandler;
