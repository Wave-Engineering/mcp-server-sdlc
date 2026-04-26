// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/label-list-{github,gitlab}.ts
// per Story 2.16 (#310); see docs/handlers/origin-operations-guide.md for the
// canonical pattern and docs/platform-adapter-retrofit-devspec.md §5 for the
// contract.
//
// Color contract (symmetric across platforms): response always carries bare
// 6-char hex (no leading `#`). The GitLab adapter strips the `#` that glab
// emits; gh already returns bare hex. See `lesson_origin_ops_pitfalls.md`.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  limit: z.number().int().positive().optional().default(100),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const labelListHandler: HandlerDef = {
  name: 'label_list',
  description:
    'List labels for the current repo. Returns name, description, and color (bare 6-char hex, no leading #) for each. Cross-platform (gh + glab).',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.labelList(args);

    if ('platform_unsupported' in result) {
      return envelope({ ok: false, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default labelListHandler;
