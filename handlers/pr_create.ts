// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string().min(1, 'body must be a non-empty string'),
  base: z.string().min(1, 'base must be a non-empty string'),
  head: z.string().optional(),
  draft: z.boolean().optional().default(false),
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

interface NormalizedPr {
  number: number;
  url: string;
  state: 'open';
  head: string;
  base: string;
}

function createGithubPr(args: Input, head: string, cwd: string): NormalizedPr {
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

  const created = run(createCmd, cwd);
  if (created.exitCode !== 0) {
    throw new Error(`gh pr create failed: ${created.stderr.trim() || created.stdout.trim()}`);
  }

  // gh pr create prints the PR URL on stdout. Parse the number from the URL.
  const url = created.stdout.trim().split('\n').pop() ?? '';
  const numMatch = /\/pull\/(\d+)/.exec(url);
  if (!numMatch) {
    throw new Error(`gh pr create: could not parse PR number from output: ${url}`);
  }
  const prNumber = parseInt(numMatch[1], 10);

  // Fetch canonical details to normalize the response.
  const view = run(
    ['gh', 'pr', 'view', String(prNumber), '--json', 'number,url,state,headRefName,baseRefName'],
    cwd,
  );
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
  };
}

function createGitlabMr(args: Input, head: string, cwd: string): NormalizedPr {
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

  const created = run(createCmd, cwd);
  if (created.exitCode !== 0) {
    throw new Error(`glab mr create failed: ${created.stderr.trim() || created.stdout.trim()}`);
  }

  // Normalize by fetching the MR we just created via `glab mr view <head> -F json`.
  const view = run(['glab', 'mr', 'view', head, '-F', 'json'], cwd);
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
