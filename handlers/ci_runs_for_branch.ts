// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching + status-flag translation live in
// lib/adapters/ci-runs-for-branch-{github,gitlab}.ts per Story 2.14 (#308);
// see docs/handlers/origin-operations-guide.md for the canonical pattern
// and docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z.object({
  branch: z.string().min(1, 'branch must be a non-empty string'),
  limit: z.number().int().positive().optional().default(10),
  status: z.enum(['success', 'failure', 'in_progress', 'all']).optional().default('all'),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const ciRunsForBranchHandler: HandlerDef = {
  name: 'ci_runs_for_branch',
  description:
    'List recent workflow/pipeline runs for a branch, newest first. Supports GitHub (gh run) and GitLab (glab ci).',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.ciRunsForBranch(args);

    // ciRunsForBranch is fully migrated on both platforms — `platform_unsupported`
    // isn't a valid outcome here, but branch defensively to keep the contract
    // honest if the interface shape changes.
    if ('platform_unsupported' in result) {
      return envelope({ ok: false, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });

    return envelope({ ok: true, runs: result.data.runs });
  },
};

export default ciRunsForBranchHandler;
