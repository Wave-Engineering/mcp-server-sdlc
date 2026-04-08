import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  head: z.string().optional(),
  base: z.string().optional(),
  state: z.enum(['open', 'closed', 'merged', 'all']).optional().default('open'),
  author: z.string().optional(),
  limit: z.number().int().positive().optional().default(20),
});

type Input = z.infer<typeof inputSchema>;

interface NormalizedPr {
  number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  url: string;
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = exec('git remote get-url origin');
    return url.includes('github') ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}

function quoteArg(s: string): string {
  // Single-quote the arg and escape any embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface GithubPr {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  url: string;
}

function listGithubPrs(args: Input): NormalizedPr[] {
  const flags: string[] = [];
  if (args.head !== undefined) flags.push(`--head ${quoteArg(args.head)}`);
  if (args.base !== undefined) flags.push(`--base ${quoteArg(args.base)}`);
  flags.push(`--state ${quoteArg(args.state)}`);
  if (args.author !== undefined) flags.push(`--author ${quoteArg(args.author)}`);
  flags.push(`--limit ${args.limit}`);
  flags.push('--json number,title,state,headRefName,baseRefName,url');

  const cmd = `gh pr list ${flags.join(' ')}`;
  const raw = exec(cmd);
  const parsed = JSON.parse(raw) as GithubPr[];
  return parsed.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    head: pr.headRefName,
    base: pr.baseRefName,
    url: pr.url,
  }));
}

interface GitlabMr {
  iid: number;
  title: string;
  state: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
}

function listGitlabMrs(args: Input): NormalizedPr[] {
  const flags: string[] = [];
  if (args.head !== undefined) flags.push(`--source-branch ${quoteArg(args.head)}`);
  if (args.base !== undefined) flags.push(`--target-branch ${quoteArg(args.base)}`);
  flags.push(`--state ${quoteArg(args.state)}`);
  if (args.author !== undefined) flags.push(`--author ${quoteArg(args.author)}`);
  flags.push(`--per-page ${args.limit}`);
  flags.push('--output json');

  const cmd = `glab mr list ${flags.join(' ')}`;
  const raw = exec(cmd);
  const parsed = JSON.parse(raw) as GitlabMr[];
  return parsed.map((mr) => ({
    number: mr.iid,
    title: mr.title,
    state: mr.state,
    head: mr.source_branch,
    base: mr.target_branch,
    url: mr.web_url,
  }));
}

const prListHandler: HandlerDef = {
  name: 'pr_list',
  description:
    'List PRs (GitHub) or MRs (GitLab) filtered by head branch, base branch, state, and author. Used to check whether a PR already exists for the current branch before creating a new one.',
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
      const platform = detectPlatform();
      const prs = platform === 'github' ? listGithubPrs(args) : listGitlabMrs(args);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, prs }) },
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

export default prListHandler;
