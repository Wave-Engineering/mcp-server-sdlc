// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/glab';

const inputSchema = z.object({
  limit: z.number().int().positive().optional().default(100),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

interface NormalizedLabel {
  name: string;
  description: string;
  color: string;
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface GithubLabel {
  name: string;
  description?: string;
  color?: string;
}

function listGithubLabels(args: Input): NormalizedLabel[] {
  const parts = ['gh', 'label', 'list', '--json', 'name,description,color', '--limit', String(args.limit)];
  if (args.repo !== undefined) {
    parts.push('--repo', quoteArg(args.repo));
  }
  const raw = exec(parts.join(' '));
  const parsed = JSON.parse(raw) as GithubLabel[];
  return parsed.map((l) => ({
    name: l.name,
    description: l.description ?? '',
    color: l.color ?? '',
  }));
}

interface GitlabLabel {
  name: string;
  description?: string;
  // glab label list returns `color` as `#RRGGBB` (with leading #); normalize to bare hex.
  color?: string;
}

function listGitlabLabels(args: Input): NormalizedLabel[] {
  const parts = ['glab', 'label', 'list', '-F', 'json', '--per-page', String(args.limit)];
  if (args.repo !== undefined) {
    parts.push('-R', quoteArg(args.repo));
  }
  const raw = exec(parts.join(' '));
  const parsed = JSON.parse(raw) as GitlabLabel[];
  return parsed.map((l) => ({
    name: l.name,
    description: l.description ?? '',
    color: (l.color ?? '').replace(/^#/, ''),
  }));
}

const labelListHandler: HandlerDef = {
  name: 'label_list',
  description:
    'List labels for the current repo. Returns name, description, and color (bare 6-char hex, no leading #) for each. Cross-platform (gh + glab).',
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
      const labels = platform === 'github' ? listGithubLabels(args) : listGitlabLabels(args);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, labels, count: labels.length }) },
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

export default labelListHandler;
