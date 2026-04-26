import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';

const inputSchema = z.object({
  type: z.enum(['epic', 'story', 'bug', 'chore', 'docs', 'pr', 'mr']),
  title: z.string(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  head_branch: z.string().optional(),
  base_branch: z.string().optional(),
  draft: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

const TYPE_LABELS: Record<string, string | null> = {
  epic: 'type::epic',
  story: 'type::story',
  bug: 'type::bug',
  chore: 'type::chore',
  docs: 'type::docs',
  pr: null,
  mr: null,
};

function buildLabels(type: string, extra: string[] = []): string[] {
  const auto = TYPE_LABELS[type];
  return auto ? [auto, ...extra] : [...extra];
}

function writeTempBody(body: string): string {
  const path = `/tmp/wi-body-${Date.now()}.md`;
  writeFileSync(path, body);
  return path;
}

function parseOutput(output: string): { url: string; number: number } {
  // gh / glab outputs the URL on its own line
  const lines = output.trim().split('\n');
  const url = lines[lines.length - 1].trim();
  const match = url.match(/\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  return { url, number };
}

function createGithubIssue(args: Input, bodyFile: string): string {
  const labels = buildLabels(args.type, args.labels);
  const parts = ['gh', 'issue', 'create', '--title', `"${args.title}"`, '--body-file', bodyFile];
  for (const label of labels) {
    parts.push('--label', `"${label}"`);
  }
  return execSync(parts.join(' '), { encoding: 'utf8' });
}

function createGitlabIssue(args: Input, bodyFile: string): string {
  const labels = buildLabels(args.type, args.labels);
  const parts = ['glab', 'issue', 'create', '--title', `"${args.title}"`, '--description', `"$(cat ${bodyFile})"`];
  if (labels.length > 0) {
    parts.push('--label', `"${labels.join(',')}"`);
  }
  return execSync(parts.join(' '), { encoding: 'utf8' });
}

function createGithubPR(args: Input, bodyFile: string): string {
  const parts = ['gh', 'pr', 'create', '--title', `"${args.title}"`, '--body-file', bodyFile];
  if (args.head_branch) parts.push('--head', args.head_branch);
  if (args.base_branch) parts.push('--base', args.base_branch);
  if (args.draft) parts.push('--draft');
  const labels = args.labels ?? [];
  for (const label of labels) {
    parts.push('--label', `"${label}"`);
  }
  return execSync(parts.join(' '), { encoding: 'utf8' });
}

function createGitlabMR(args: Input, bodyFile: string): string {
  const parts = ['glab', 'mr', 'create', '--title', `"${args.title}"`, '--description', `"$(cat ${bodyFile})"`];
  if (args.head_branch) parts.push('--source-branch', args.head_branch);
  if (args.base_branch) parts.push('--target-branch', args.base_branch);
  if (args.draft) parts.push('--draft');
  return execSync(parts.join(' '), { encoding: 'utf8' });
}

const workItemHandler: HandlerDef = {
  name: 'work_item',
  description: 'Create a GitHub issue, PR, or GitLab issue/MR via the appropriate CLI.',
  inputSchema,
  async execute(rawArgs: unknown) {
    const args = inputSchema.parse(rawArgs);
    const bodyContent = args.body ?? '';
    const bodyFile = writeTempBody(bodyContent);
    const platform = detectPlatform();

    try {
      let output: string;
      const isIssueType = !['pr', 'mr'].includes(args.type);

      if (isIssueType) {
        output = platform === 'github'
          ? createGithubIssue(args, bodyFile)
          : createGitlabIssue(args, bodyFile);
      } else if (args.type === 'pr') {
        output = createGithubPR(args, bodyFile);
      } else {
        output = createGitlabMR(args, bodyFile);
      }

      const { url, number } = parseOutput(output);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url, number }) }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default workItemHandler;
