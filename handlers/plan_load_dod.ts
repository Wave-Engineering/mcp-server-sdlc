/**
 * `plan_load_dod` handler — fetches a Plan tracking-issue and returns
 * a parsed view of its Plan-level Definition of Done plus per-Phase DoD
 * checklists.
 *
 * Story #388: Add plan_load_dod MCP tool to extract DoD from Plan-issue body.
 * Part of the Plan DoD workflow family.
 */

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { parsePlanBody, validatePlanBodyStructure } from '../lib/plan-body-parse.js';

const inputSchema = z.object({
  plan_id: z.number().int().positive(),
  repo: z.string().optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const planLoadDodHandler: HandlerDef = {
  name: 'plan_load_dod',
  description: 'Fetch a Plan tracking-issue and extract its Definition of Done structure',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.fetchIssue({ number: args.plan_id, repo: args.repo });

    if ('platform_unsupported' in result) {
      return envelope({ ok: false, error: result.hint });
    }

    if (!result.ok) {
      // Platform CLI failure
      return envelope({ ok: false, error: result.error, code: result.code });
    }

    const issue = result.data;

    // Check if issue exists (already handled by adapter, but explicit check for clarity)
    if (!issue) {
      return envelope({
        ok: false,
        code: 'plan_not_found',
        error: `Plan issue #${args.plan_id} not found`,
      });
    }

    // Validate Plan body structure
    const missingHeadings = validatePlanBodyStructure(issue.body);
    if (missingHeadings.length > 0) {
      return envelope({
        ok: false,
        code: 'plan_body_invalid',
        error: `Plan body missing required headings: ${missingHeadings.join(', ')}`,
        missing_headings: missingHeadings,
      });
    }

    // Parse the Plan body
    const parsed = parsePlanBody(issue.body);

    // Build response
    return envelope({
      ok: true,
      plan_id: issue.number,
      plan_title: issue.title,
      plan_level_dod: parsed.plan_level_dod,
      phases: parsed.phases,
      devspec_path: parsed.devspec_path,
      references: parsed.references,
    });
  },
};

export default planLoadDodHandler;
