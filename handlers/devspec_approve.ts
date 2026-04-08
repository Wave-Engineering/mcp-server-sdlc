import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  approver: z.string().min(1, 'approver must be a non-empty string'),
  finalization_score: z.string().optional().default('7/7'),
});

type Input = z.infer<typeof inputSchema>;

const APPROVAL_BLOCK_REGEX = /<!--\s*DEV-SPEC-APPROVAL[\s\S]*?-->\s*\n?/;

/**
 * Build the DEV-SPEC-APPROVAL comment block with the given metadata.
 */
function buildApprovalBlock(approver: string, approvedAt: string, score: string): string {
  return [
    '<!-- DEV-SPEC-APPROVAL',
    'approved: true',
    `approved_by: ${approver}`,
    `approved_at: ${approvedAt}`,
    `finalization_score: ${score}`,
    '-->',
  ].join('\n');
}

/**
 * Generate a current UTC ISO 8601 timestamp (seconds precision, Z suffix).
 * Example: 2026-04-08T13:42:00Z
 */
function nowIso(): string {
  const d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Return the end index (exclusive) of the YAML frontmatter block, or 0 if absent.
 * Frontmatter is a `---` line at position 0 followed by content and a closing `---` line.
 */
function frontmatterEndIndex(body: string): number {
  if (!body.startsWith('---\n') && !body.startsWith('---\r\n')) return 0;
  // Find the closing '---' line after the opening one.
  const openLen = body.startsWith('---\r\n') ? 5 : 4;
  const rest = body.slice(openLen);
  const closeMatch = /(^|\n)---(\r?\n|$)/.exec(rest);
  if (!closeMatch) return 0;
  const closeIdx = closeMatch.index + (closeMatch[1] === '\n' ? 1 : 0);
  const closeEnd = closeIdx + 3 + (closeMatch[2].length); // include closing --- and its newline
  return openLen + closeEnd;
}

/**
 * Insert the approval block into the document. If an existing block exists it is
 * replaced in place; otherwise the block is inserted after the frontmatter (if any)
 * or at the top of the document (before Section 1 / first line).
 */
function insertOrReplaceBlock(body: string, block: string): string {
  if (APPROVAL_BLOCK_REGEX.test(body)) {
    // Replace existing block, preserving a single trailing newline after.
    return body.replace(APPROVAL_BLOCK_REGEX, `${block}\n\n`);
  }

  const fmEnd = frontmatterEndIndex(body);
  if (fmEnd > 0) {
    const before = body.slice(0, fmEnd);
    const after = body.slice(fmEnd);
    // Ensure a blank line separates frontmatter from the block.
    const sep = after.startsWith('\n') ? '' : '\n';
    return `${before}${sep}${block}\n\n${after.replace(/^\n+/, '')}`;
  }

  // No frontmatter: insert at top of document, before any Section 1 heading.
  const sep = body.startsWith('\n') ? '' : '';
  return `${block}\n\n${sep}${body.replace(/^\n+/, '')}`;
}

const devspecApproveHandler: HandlerDef = {
  name: 'devspec_approve',
  description:
    'Write a DEV-SPEC-APPROVAL metadata comment block into a Dev Spec file. Replaces any existing block.',
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
      const file = Bun.file(args.path);
      if (!(await file.exists())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, error: `file not found: ${args.path}` }),
            },
          ],
        };
      }

      const original = await file.text();
      const approvedAt = nowIso();
      const block = buildApprovalBlock(args.approver, approvedAt, args.finalization_score);
      const updated = insertOrReplaceBlock(original, block);
      await Bun.write(args.path, updated);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              path: args.path,
              approved_at: approvedAt,
              approved_by: args.approver,
              finalization_score: args.finalization_score,
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

export default devspecApproveHandler;
