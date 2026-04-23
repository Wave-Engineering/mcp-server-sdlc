// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform, gitlabApiMr } from '../lib/glab';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

type FileStatus = 'added' | 'modified' | 'removed' | 'renamed';

interface FileEntry {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function exec(cmd: string): string {
  return execSync(cmd, { cwd: projectDir(), encoding: 'utf8' });
}

function mapGithubChangeType(changeType: string): FileStatus {
  switch (changeType.toUpperCase()) {
    case 'ADDED':
      return 'added';
    case 'REMOVED':
    case 'DELETED':
      return 'removed';
    case 'RENAMED':
      return 'renamed';
    case 'MODIFIED':
    case 'CHANGED':
    default:
      return 'modified';
  }
}

interface GithubFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

function repoFlag(repo: string | undefined): string {
  return repo !== undefined ? ` --repo ${repo}` : '';
}

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

function getGithubFiles(number: number, repo?: string): FileEntry[] {
  const raw = exec(`gh pr view ${number} --json files${repoFlag(repo)}`);
  const parsed = JSON.parse(raw) as { files: GithubFile[] };
  const files = parsed.files ?? [];
  return files.map(f => ({
    path: f.path,
    status: mapGithubChangeType(f.changeType),
    additions: typeof f.additions === 'number' ? f.additions : 0,
    deletions: typeof f.deletions === 'number' ? f.deletions : 0,
  }));
}

interface GitlabChange {
  new_path?: string;
  old_path?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string;
}

/**
 * Parse a unified-diff hunk string and return additions/deletions.
 * Additions are lines starting with a single '+' (not '+++').
 * Deletions are lines starting with a single '-' (not '---').
 * Hunk headers (@@) and context lines are ignored.
 */
export function parseDiffStats(diff: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function mapGitlabStatus(change: GitlabChange): FileStatus {
  if (change.new_file) return 'added';
  if (change.deleted_file) return 'removed';
  if (change.renamed_file) return 'renamed';
  return 'modified';
}

function getGitlabFiles(number: number, repo?: string): FileEntry[] {
  const mr = gitlabApiMr(number, parseSlugOpts(repo)) as unknown as { changes?: GitlabChange[] };
  const changes = mr.changes ?? [];
  return changes.map(c => {
    const path = c.new_path ?? c.old_path ?? '';
    const status = mapGitlabStatus(c);
    const { additions, deletions } = parseDiffStats(c.diff ?? '');
    return { path, status, additions, deletions };
  });
}

const prFilesHandler: HandlerDef = {
  name: 'pr_files',
  description:
    'List changed files in a PR/MR with path, status (added/modified/removed/renamed), and additions/deletions. Works on both GitHub and GitLab.',
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
      const files =
        platform === 'github'
          ? getGithubFiles(args.number, args.repo)
          : getGitlabFiles(args.number, args.repo);

      const total_additions = files.reduce((sum, f) => sum + f.additions, 0);
      const total_deletions = files.reduce((sum, f) => sum + f.deletions, 0);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              number: args.number,
              files,
              total_additions,
              total_deletions,
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

export default prFilesHandler;
