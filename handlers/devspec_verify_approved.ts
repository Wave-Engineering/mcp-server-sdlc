import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

type Input = z.infer<typeof inputSchema>;

interface ApprovalMetadata {
  approved: boolean;
  approved_by?: string;
  approved_at?: string;
  finalization_score?: string;
}

/**
 * Read a file via shell-out (cat) to stay consistent with the
 * child_process.execSync convention used throughout this codebase.
 * Throws an informative error if the file cannot be read.
 */
function readFileViaShell(path: string): string {
  try {
    // -- guards against paths that look like flags.
    return execSync(`cat -- ${shellQuote(path)}`, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`file not found or unreadable: ${path} (${msg})`);
  }
}

/**
 * Minimal single-quote shell quoting.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Locate the DEV-SPEC-APPROVAL comment block in a markdown body.
 *
 * Looks for an HTML comment whose first line (after `<!--`) is
 * `DEV-SPEC-APPROVAL`. Captures the body of that comment up to the
 * closing `-->`. Returns null when the opening marker is not found.
 * Throws when the marker is found but the comment is unterminated.
 */
function extractApprovalBlock(markdown: string): string | null {
  // Match: <!-- (optional whitespace/newline) DEV-SPEC-APPROVAL ... -->
  // We scan manually so we can produce a targeted error for unterminated blocks.
  const startRe = /<!--\s*DEV-SPEC-APPROVAL\b/;
  const startMatch = startRe.exec(markdown);
  if (!startMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  const endIdx = markdown.indexOf('-->', startIdx);
  if (endIdx === -1) {
    throw new Error(
      'malformed DEV-SPEC-APPROVAL block: unterminated comment (no closing `-->`)'
    );
  }
  return markdown.slice(startIdx, endIdx);
}

/**
 * Parse `key: value` pairs from a DEV-SPEC-APPROVAL block body.
 *
 * Each non-empty line is expected to match `key: value`. Unknown keys
 * are tolerated and ignored. Lines that cannot be parsed surface as
 * an informative error.
 */
function parseApprovalBlock(body: string): ApprovalMetadata {
  const lines = body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) {
    throw new Error(
      'malformed DEV-SPEC-APPROVAL block: block is empty (no `approved:` field)'
    );
  }

  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(
        `malformed DEV-SPEC-APPROVAL block: could not parse line "${line}" (expected "key: value")`
      );
    }
    fields[m[1]] = m[2].trim();
  }

  if (!('approved' in fields)) {
    throw new Error(
      'malformed DEV-SPEC-APPROVAL block: missing required `approved` field'
    );
  }

  const approvedRaw = fields.approved.toLowerCase();
  if (approvedRaw !== 'true' && approvedRaw !== 'false') {
    throw new Error(
      `malformed DEV-SPEC-APPROVAL block: \`approved\` must be "true" or "false", got "${fields.approved}"`
    );
  }

  const result: ApprovalMetadata = {
    approved: approvedRaw === 'true',
  };
  if (fields.approved_by) result.approved_by = fields.approved_by;
  if (fields.approved_at) result.approved_at = fields.approved_at;
  if (fields.finalization_score) result.finalization_score = fields.finalization_score;
  return result;
}

const devspecVerifyApprovedHandler: HandlerDef = {
  name: 'devspec_verify_approved',
  description:
    'Check whether a Dev Spec file has been approved via its DEV-SPEC-APPROVAL metadata comment block.',
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

    let body: string;
    try {
      body = readFileViaShell(args.path);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    let block: string | null;
    try {
      block = extractApprovalBlock(body);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    if (block === null) {
      // No block at all — this is a valid "not approved" result, not an error.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, path: args.path, approved: false }),
          },
        ],
      };
    }

    let meta: ApprovalMetadata;
    try {
      meta = parseApprovalBlock(block);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    const payload: {
      ok: true;
      path: string;
      approved: boolean;
      approved_by?: string;
      approved_at?: string;
      finalization_score?: string;
    } = {
      ok: true,
      path: args.path,
      approved: meta.approved,
    };
    if (meta.approved_by) payload.approved_by = meta.approved_by;
    if (meta.approved_at) payload.approved_at = meta.approved_at;
    if (meta.finalization_score) payload.finalization_score = meta.finalization_score;

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    };
  },
};

export default devspecVerifyApprovedHandler;
