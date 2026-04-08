import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  number: z.number().int().positive(),
});

type Input = z.infer<typeof inputSchema>;

const MAX_LINES = 10000;
const HEAD_KEEP = 5000;
const TAIL_KEEP = 5000;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function exec(cmd: string): string {
  return execSync(cmd, {
    cwd: projectDir(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, // 256 MiB — diffs can be large
  });
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: projectDir(),
      encoding: 'utf8',
    }).trim();
    return url.includes('gitlab') ? 'gitlab' : 'github';
  } catch {
    return 'github';
  }
}

function getGithubDiff(num: number): string {
  return exec(`gh pr diff ${num}`);
}

function getGithubUrl(num: number): string {
  const raw = exec(`gh pr view ${num} --json url`);
  const parsed = JSON.parse(raw) as { url: string };
  return parsed.url;
}

function getGitlabDiff(num: number): string {
  return exec(`glab mr diff ${num}`);
}

function getGitlabUrl(num: number): string {
  const raw = exec(`glab mr view ${num} --output json`);
  const parsed = JSON.parse(raw) as { web_url: string };
  return parsed.web_url;
}

function countLines(diff: string): number {
  if (diff.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < diff.length; i++) {
    if (diff.charCodeAt(i) === 10) count++;
  }
  // If the diff doesn't end with a newline, the last line still counts.
  if (diff.charCodeAt(diff.length - 1) !== 10) count++;
  return count;
}

function countFiles(diff: string): number {
  if (diff.length === 0) return 0;
  const matches = diff.match(/^diff --git /gm);
  return matches ? matches.length : 0;
}

interface TruncateResult {
  diff: string;
  truncated: boolean;
}

function maybeTruncate(diff: string, lineCount: number): TruncateResult {
  if (lineCount <= MAX_LINES) {
    return { diff, truncated: false };
  }

  // Split on newlines while preserving them.
  const lines = diff.split('\n');
  // If diff ends with '\n', split produces a trailing empty string; drop it
  // so the keep-count math lines up with countLines() above.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();

  const totalLines = lines.length;
  const head = lines.slice(0, HEAD_KEEP);
  const tail = lines.slice(totalLines - TAIL_KEEP);
  const omitted = totalLines - HEAD_KEEP - TAIL_KEEP;

  const joined =
    head.join('\n') +
    `\n... [${omitted} lines omitted] ...\n` +
    tail.join('\n') +
    (hadTrailingNewline ? '\n' : '');

  return { diff: joined, truncated: true };
}

const prDiffHandler: HandlerDef = {
  name: 'pr_diff',
  description:
    'Fetch the unified diff for a PR/MR as a single string, with line/file counts and a safety-valve truncation above 10000 lines.',
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
      const rawDiff =
        platform === 'github' ? getGithubDiff(args.number) : getGitlabDiff(args.number);
      const url =
        platform === 'github' ? getGithubUrl(args.number) : getGitlabUrl(args.number);

      const rawLineCount = countLines(rawDiff);
      const fileCount = countFiles(rawDiff);
      const { diff, truncated } = maybeTruncate(rawDiff, rawLineCount);
      const lineCount = truncated ? countLines(diff) : rawLineCount;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              number: args.number,
              diff,
              line_count: lineCount,
              file_count: fileCount,
              url,
              truncated,
            }),
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

export default prDiffHandler;
