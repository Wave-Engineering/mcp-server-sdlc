// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';

// 6-char hex (no leading #). Both gh and glab accept color in this form.
const HEX_COLOR_RE = /^[0-9a-fA-F]{6}$/;

const inputSchema = z.object({
  name: z.string().min(1, 'name must be a non-empty string'),
  description: z.string().optional().default(''),
  color: z
    .string()
    .regex(HEX_COLOR_RE, 'color must be a 6-char hex (no leading #)')
    .optional(),
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
  created: boolean; // true if newly created, false if already existed
}

interface ExecError extends Error {
  stderr?: Buffer | string;
  stdout?: Buffer | string;
}

function bufToString(b: unknown): string {
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (typeof (b as Buffer).toString === 'function') return (b as Buffer).toString();
  return String(b);
}

function exec(cmd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const out = execSync(cmd, { encoding: 'utf8' });
    return { ok: true, stdout: out.trim(), stderr: '' };
  } catch (err) {
    const e = err as ExecError;
    return {
      ok: false,
      stdout: bufToString(e.stdout).trim(),
      stderr: bufToString(e.stderr).trim() || e.message || '',
    };
  }
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * gh and glab both report "label already exists" on the duplicate path.
 * Heuristic match — phrasing varies across CLI versions but consistently
 * includes the substring "already exists".
 */
function stderrIndicatesDuplicate(text: string): boolean {
  return /already exists/i.test(text);
}

function lookupGithubLabel(name: string, repo: string | undefined): NormalizedLabel | null {
  const parts = ['gh', 'label', 'list', '--search', quoteArg(name), '--json', 'name,description,color', '--limit', '20'];
  if (repo !== undefined) {
    parts.push('--repo', quoteArg(repo));
  }
  const result = exec(parts.join(' '));
  if (!result.ok) return null;
  try {
    const labels = JSON.parse(result.stdout) as Array<{ name: string; description?: string; color?: string }>;
    // gh label list --search is a fuzzy match; pick the exact case-insensitive name.
    const match = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) return null;
    return {
      name: match.name,
      description: match.description ?? '',
      color: match.color ?? '',
      created: false,
    };
  } catch {
    return null;
  }
}

function createGithubLabel(args: Input): NormalizedLabel {
  const parts = ['gh', 'label', 'create', quoteArg(args.name)];
  if (args.description.length > 0) {
    parts.push('--description', quoteArg(args.description));
  }
  if (args.color !== undefined) {
    parts.push('--color', quoteArg(args.color));
  }
  if (args.repo !== undefined) {
    parts.push('--repo', quoteArg(args.repo));
  }
  const result = exec(parts.join(' '));
  if (!result.ok) {
    if (stderrIndicatesDuplicate(result.stderr) || stderrIndicatesDuplicate(result.stdout)) {
      const existing = lookupGithubLabel(args.name, args.repo);
      if (existing !== null) return existing;
      throw new Error(
        `gh label create: label '${args.name}' already exists but could not be found via lookup`,
      );
    }
    throw new Error(`gh label create failed: ${result.stderr || result.stdout}`);
  }
  return {
    name: args.name,
    description: args.description,
    color: args.color ?? '',
    created: true,
  };
}

function lookupGitlabLabel(name: string, repo: string | undefined): NormalizedLabel | null {
  const parts = ['glab', 'label', 'list', '-F', 'json', '--per-page', '100'];
  if (repo !== undefined) {
    parts.push('-R', quoteArg(repo));
  }
  const result = exec(parts.join(' '));
  if (!result.ok) return null;
  try {
    const labels = JSON.parse(result.stdout) as Array<{ name: string; description?: string; color?: string }>;
    const match = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) return null;
    return {
      name: match.name,
      description: match.description ?? '',
      color: (match.color ?? '').replace(/^#/, ''),
      created: false,
    };
  } catch {
    return null;
  }
}

function createGitlabLabel(args: Input): NormalizedLabel {
  const parts = ['glab', 'label', 'create', '--name', quoteArg(args.name)];
  if (args.description.length > 0) {
    parts.push('--description', quoteArg(args.description));
  }
  if (args.color !== undefined) {
    // GitLab's REST API requires `#RRGGBB`; bare hex is rejected. Schema
    // takes bare hex (consumer-friendly, symmetric with the gh path);
    // prepend the `#` here when handing off to glab.
    parts.push('--color', quoteArg(`#${args.color}`));
  }
  if (args.repo !== undefined) {
    parts.push('-R', quoteArg(args.repo));
  }
  const result = exec(parts.join(' '));
  if (!result.ok) {
    if (stderrIndicatesDuplicate(result.stderr) || stderrIndicatesDuplicate(result.stdout)) {
      const existing = lookupGitlabLabel(args.name, args.repo);
      if (existing !== null) return existing;
      throw new Error(
        `glab label create: label '${args.name}' already exists but could not be found via lookup`,
      );
    }
    throw new Error(`glab label create failed: ${result.stderr || result.stdout}`);
  }
  return {
    name: args.name,
    description: args.description,
    color: args.color ?? '',
    created: true,
  };
}

const labelCreateHandler: HandlerDef = {
  name: 'label_create',
  description:
    'Create a label on the current repo. Idempotent: returns the existing label with `created: false` if it already exists. Color is a 6-char hex (no leading #). Cross-platform (gh + glab).',
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
      const label = platform === 'github' ? createGithubLabel(args) : createGitlabLabel(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...label }) }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default labelCreateHandler;
