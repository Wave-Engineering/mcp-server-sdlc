// work_item_update — adapter-dispatching shell (#287).
// Sister to handlers/work_item.ts: that one creates issues/PRs; this one
// updates an existing issue's title, body, labels, assignees, milestone, or a
// single H2 section of the body. Subprocess and platform branching live in
// lib/adapters/work-item-update-{github,gitlab}.ts; this handler is purely the
// schema validation + envelope shaping.
//
// Section-level patches: when patch.body_section is provided, the adapter
// reads the current issue body, splices the section, and sends the resulting
// full body to the platform CLI's edit/update sub-command. This preserves all
// other sections verbatim — the AC contract for #287.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const issueRefSchema = z
  .string()
  .regex(/^(?:[A-Za-z0-9._/-]+#)?\d+$|^#\d+$/, 'issue_ref must match `#N` or `owner/repo#N`');

const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    body_section: z
      .object({
        heading: z.string().min(1, 'body_section.heading must be non-empty'),
        content: z.string(),
      })
      .optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    milestone: z.string().optional(),
  })
  .refine(
    (p) =>
      p.title !== undefined ||
      p.body !== undefined ||
      p.body_section !== undefined ||
      p.labels !== undefined ||
      p.assignees !== undefined ||
      p.milestone !== undefined,
    { message: 'patch must include at least one field' },
  )
  .refine((p) => !(p.body !== undefined && p.body_section !== undefined), {
    message: 'patch.body and patch.body_section are mutually exclusive',
  });

const inputSchema = z.object({
  issue_ref: issueRefSchema,
  patch: patchSchema,
  dry_run: z.boolean().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._/-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const workItemUpdateHandler: HandlerDef = {
  name: 'work_item_update',
  description:
    'Update an existing GitHub or GitLab issue (title, body, body_section, labels, assignees, milestone). Section-level patches preserve all other H2 sections. Use dry_run:true to preview without committing. Sister tool to `work_item` (which is create-only).',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.workItemUpdate(args);

    if ('platform_unsupported' in result) {
      return envelope({ ok: false, platform_unsupported: true, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error, code: result.code });
    return envelope({ ok: true, ...result.data });
  },
};

export default workItemUpdateHandler;
