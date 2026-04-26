// Spec-family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/fetch-issue-{github,gitlab}.ts
// (Story 2.1, #295); this handler consumes the normalized `AdapterIssue` shape
// via `getAdapter().fetchIssue(...)`. Markdown section-parsing (`parseSections`)
// stays here — it's platform-agnostic.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function repoSlug(ref: IssueRef): string | undefined {
  if (ref.owner && ref.repo) return `${ref.owner}/${ref.repo}`;
  return undefined;
}

const specGetHandler: HandlerDef = {
  name: 'spec_get',
  description: 'Fetch an issue and return its body parsed into structured sections',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const ref = parseIssueRef(args.issue_ref);
    if (!ref) {
      return envelope({
        ok: false,
        error: `could not parse issue_ref: '${args.issue_ref}' (expected #N or org/repo#N)`,
      });
    }

    const repo = repoSlug(ref);
    const result = await getAdapter({ repo }).fetchIssue({ number: ref.number, repo });

    if ('platform_unsupported' in result) return envelope({ ok: false, error: result.hint });
    if (!result.ok) return envelope({ ok: false, error: result.error });

    const info = result.data;
    const { sections, order } = parseSections(info.body);
    return envelope({
      ok: true,
      number: info.number,
      title: info.title,
      state: info.state,
      labels: info.labels,
      body: info.body,
      sections,
      section_order: order,
    });
  },
};

export default specGetHandler;
