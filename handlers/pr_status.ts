// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-status-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  number: z.number().int().positive(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prStatusHandler: HandlerDef = {
  name: 'pr_status',
  description:
    'Get the current state of a PR/MR: open/merged/closed, merge state (clean/unstable/dirty/blocked/unknown), mergeable flag, and a summary of check runs. Used by /mmr to verify CI before merging.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.prStatus(args);

    // Per dev spec §4.4 step 4: surface `platform_unsupported` as a typed
    // signal alongside `ok: true` — NOT as an error. The dispatch succeeded;
    // the platform just doesn't have the concept. Callers branch on the
    // discriminator instead of confusing it with a runtime failure.
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    // pr_status preserves the legacy `{ok: true, data: {...}}` envelope
    // (rather than spreading like other migrated handlers) so downstream
    // callers — e.g. /mmr — that read `result.data.checks.summary` keep
    // working unchanged.
    return envelope({ ok: true, data: result.data });
  },
};

export default prStatusHandler;
