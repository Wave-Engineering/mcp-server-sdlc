// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/label-create-{github,gitlab}.ts
// per Story 2.15 (#309); see docs/handlers/origin-operations-guide.md for the
// canonical pattern and docs/platform-adapter-retrofit-devspec.md §5 for the
// contract.
//
// Color contract: schema accepts BARE 6-char hex (no leading `#`). Adapters
// own the platform-specific hand-off — gh takes bare hex, glab prepends `#`.
// See `lesson_origin_ops_pitfalls.md`.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

// 6-char hex (no leading #). Both gh and glab accept color in this form at
// the adapter boundary; glab's `#` prefix is applied inside the adapter.
const HEX_COLOR_RE = /^[0-9a-fA-F]{6}$/;

const inputSchema = z.object({
  name: z.string().min(1, 'name must be a non-empty string'),
  description: z.string().optional().default(''),
  color: z
    .string()
    .regex(HEX_COLOR_RE, 'color must be a 6-char hex (no leading #)')
    .optional(),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const labelCreateHandler: HandlerDef = {
  name: 'label_create',
  description:
    'Create a label on the current repo. Idempotent: returns the existing label with `created: false` if it already exists. Color is a 6-char hex (no leading #). Cross-platform (gh + glab).',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.labelCreate(args);

    if ('platform_unsupported' in result) {
      return envelope({ ok: false, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default labelCreateHandler;
