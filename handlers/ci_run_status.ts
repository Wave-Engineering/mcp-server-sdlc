// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching + status-enum normalization live in
// lib/adapters/ci-run-status-{github,gitlab}.ts per Story 2.13 (#307);
// see docs/handlers/origin-operations-guide.md for the canonical pattern
// and docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z
  .object({
    ref: z.string().min(1, 'ref must be a non-empty string'),
    workflow_name: z.string().optional(),
    repo: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be in owner/repo form')
      .optional(),
  })
  .strict();

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const ciRunStatusHandler: HandlerDef = {
  name: 'ci_run_status',
  description:
    'Get the latest CI workflow/pipeline run status for a commit SHA or branch ref, optionally filtered by workflow name.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.ciRunStatus(args);

    // ciRunStatus is fully migrated on both platforms — `platform_unsupported`
    // isn't a valid outcome here, but branch defensively to keep the contract
    // honest if the interface shape changes.
    if ('platform_unsupported' in result) {
      return envelope({ ok: false, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });

    if (result.data === null) {
      const filter = args.workflow_name ? ` with workflow '${args.workflow_name}'` : '';
      return envelope({
        ok: false,
        code: 'no_runs_found',
        error: `no CI runs found for ref '${args.ref}'${filter}`,
      });
    }

    return envelope({ ok: true, data: result.data });
  },
};

export default ciRunStatusHandler;
