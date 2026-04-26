// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-files-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

// Re-export `parseDiffStats` so existing importers (e.g. tests/pr_files.test.ts)
// keep working. The canonical implementation lives in the GitLab adapter; this
// shim preserves the historical public surface without forcing a test churn.
export { parseDiffStats } from '../lib/adapters/pr-files-gitlab.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prFilesHandler: HandlerDef = {
  name: 'pr_files',
  description:
    'List changed files in a PR/MR with path, status (added/modified/removed/renamed), and additions/deletions. Works on both GitHub and GitLab.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.prFiles(args);

    // Per dev spec §4.4 step 4: surface `platform_unsupported` as a typed
    // signal alongside `ok: true` — NOT as an error. The dispatch succeeded;
    // the platform just doesn't have the concept. Callers branch on the
    // discriminator instead of confusing it with a runtime failure.
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default prFilesHandler;
