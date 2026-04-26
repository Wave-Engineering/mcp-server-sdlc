// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/ci-run-logs-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.
//
// The truncation step is platform-agnostic and composes AFTER the adapter
// returns raw logs — see `lib/shared/truncate-logs.ts` (Story 2.12, R-17).

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { truncateLogs, DEFAULT_MAX_LINES } from '../lib/shared/truncate-logs.js';

const inputSchema = z.object({
  run_id: z.number().int().nonnegative(),
  job_id: z.number().int().nonnegative().optional(),
  failed_only: z.boolean().optional().default(true),
  max_lines: z.number().int().positive().optional().default(DEFAULT_MAX_LINES),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be in owner/repo form')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const ciRunLogsHandler: HandlerDef = {
  name: 'ci_run_logs',
  description:
    'Fetch logs for a CI run (GitHub) or pipeline job (GitLab), truncated to keep response size sane. Used by /jfail.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.ciRunLogs({
      run_id: args.run_id,
      job_id: args.job_id,
      failed_only: args.failed_only,
      repo: args.repo,
    });

    // ciRunLogs is fully migrated on both platforms — `platform_unsupported`
    // isn't a valid outcome here, but branch defensively to keep the contract
    // honest if the interface shape changes.
    if ('platform_unsupported' in result) {
      return envelope({ ok: false, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });

    const { logs, line_count, truncated } = truncateLogs(result.data.logs, args.max_lines);
    return envelope({
      ok: true,
      run_id: args.run_id,
      job_id: result.data.job_id,
      logs,
      line_count,
      truncated,
      url: result.data.url,
    });
  },
};

export default ciRunLogsHandler;
