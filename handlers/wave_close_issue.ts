import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z
  .object({
    // Effectively deprecated — retained for backward compatibility. Prefer
    // issue_ref, which supports repo-qualified references for cross-repo waves.
    issue_number: z.number().int().positive().optional(),
    // When set, takes precedence over issue_number. Accepts either a bare
    // number ("185") or a repo-qualified ref ("org/repo#185").
    issue_ref: z
      .string()
      .regex(
        // Either bare number ("185") OR qualified "owner/repo#N". The `#`
        // is mandatory when the owner/repo prefix is present; standalone
        // "#185" is rejected as ambiguous.
        /^([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+#)?\d+$/,
        'issue_ref must be a bare number or qualified owner/repo#N'
      )
      .optional(),
  })
  .refine(a => a.issue_ref !== undefined || a.issue_number !== undefined, {
    message: 'either issue_ref or issue_number is required',
  });

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const waveCloseIssueHandler: HandlerDef = {
  name: 'wave_close_issue',
  description: 'Record that a wave issue has been closed',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const issueArg =
        args.issue_ref !== undefined ? quoteArg(args.issue_ref) : String(args.issue_number);
      const output = execSync(`wave-status close-issue ${issueArg}`, {
        cwd: projectDir(),
        encoding: 'utf8',
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, data: output.trim() }) },
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

export default waveCloseIssueHandler;
