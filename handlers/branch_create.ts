// Origin Operations family handler — adapter-dispatching shell (#579).
// Subprocess + platform branching live in lib/adapters/branch-create-{core,github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern.
//
// `branch_create` is the LOCAL-checkout issue-branch convenience: validate the
// name against `<type>/<N>-description`, refuse on a dirty tree, check out a
// fresh branch off the (updated) base, and additively self-assign the linked
// issue. It is a convenience, never a gate — nothing requires an agent to route
// branch creation through it (they may still `git checkout -b` by hand).

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z.object({
  branch: z.string().min(1, 'branch must be a non-empty string'),
  // base is optional — when omitted, the adapter resolves the repo's live
  // default branch (mirrors pr_create, #159).
  base: z.string().min(1).optional(),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const branchCreateHandler: HandlerDef = {
  name: 'branch_create',
  description:
    'Create a local issue branch (<type>/<N>-description) off the updated base and additively self-assign the linked issue. Refuses on a dirty tree; no auto-push. (The GitLab work-item Status transition To do → In Progress is not yet applied — deferred to #580.) A convenience, not a gate.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.branchCreate(args);

    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default branchCreateHandler;
