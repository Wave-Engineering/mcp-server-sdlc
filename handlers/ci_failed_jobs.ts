// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/ci-failed-jobs-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z
  .object({
    run_id: z.number().int().positive(),
    // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
    repo: repoOptionalSchema,
  })
  .strict();

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const ciFailedJobsHandler: HandlerDef = {
  name: 'ci_failed_jobs',
  description:
    'List failed jobs for a specific CI run with per-job reason summaries. Used by /jfail to know which jobs to pull logs for.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.ciFailedJobs(args);

    // Per dev spec §4.4 step 4: surface `platform_unsupported` as a typed
    // signal alongside `ok: true` — NOT as an error. The dispatch succeeded;
    // the platform just doesn't have the concept. Callers branch on the
    // discriminator instead of confusing it with a runtime failure.
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    return envelope({ ok: true, run_id: args.run_id, ...result.data });
  },
};

export default ciFailedJobsHandler;
