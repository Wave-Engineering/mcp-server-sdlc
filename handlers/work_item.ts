// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/work-item-{github,gitlab}.ts
// per Story 2.17 (#311); see docs/handlers/origin-operations-guide.md for the
// canonical pattern and docs/platform-adapter-retrofit-devspec.md §5 for the
// contract.
//
// Closes #281: the pre-migration dispatch ran the wrong platform's create fn
// when `type:'pr'` hit a GitLab repo (or `type:'mr'` hit GitHub). The adapter
// boundary now returns `{platform_unsupported: true, hint: ...}` for those
// combinations, which the handler surfaces as a typed error envelope rather
// than silently running the wrong sub-command.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import { validateBodyStructure } from '../lib/spec_parser';

// Issue types whose body follows the `## Changes` / `## Tests` /
// `## Acceptance Criteria` spec grammar. `pr`/`mr` use a different body shape
// (Summary/Changes/Linked Issues/Test Plan) and are deliberately excluded —
// running the issue grammar against a PR body would emit spurious warnings.
// See #487 and docs/issue-body-grammar.md.
// Body-bearing ISSUE types (excludes pr/mr, which use the PR-body shape). `fix`
// is a full peer of bug/chore/doc (same type::fix label path), so it gets the same
// body_grammar advisory — omitting it silently skipped the check for fix issues (#566).
const BODY_GRAMMAR_TYPES = new Set(['plan', 'epic', 'story', 'feature', 'bug', 'chore', 'doc', 'fix']);

const inputSchema = z.object({
  // `doc` is the canonical singular type (→ type::doc), consistent with every
  // other singular type (feature/bug/chore/fix/…). `docs` is a TRANSITIONAL
  // alias only — normalized to `doc` in execute() so type::docs is never created
  // again; its removal is tracked by #540, once cc-workflow's /issue skill emits
  // `doc` directly instead of shimming doc→docs.
  type: z.enum(['plan', 'epic', 'story', 'feature', 'bug', 'chore', 'doc', 'docs', 'fix', 'pr', 'mr']),
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  head_branch: z.string().optional(),
  base_branch: z.string().optional(),
  draft: z.boolean().optional(),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const workItemHandler: HandlerDef = {
  name: 'work_item',
  description:
    'Create a GitHub issue/PR or GitLab issue/MR via the appropriate CLI. `type` drives dispatch; cross-platform types (pr on GitLab, mr on GitHub) return a typed platform_unsupported error.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    // Normalize the transitional `docs` alias to canonical `doc` before dispatch,
    // so no downstream path (adapter type→label map, the emitted label) ever sees
    // the plural. The ternary also narrows the type to WorkItemType (`doc`, no
    // `docs`). Scaffold removal: #540.
    const type = args.type === 'docs' ? 'doc' : args.type;
    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.workItem({ ...args, type });

    if ('platform_unsupported' in result) {
      return envelope({ ok: false, platform_unsupported: true, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });

    // Body-grammar warning (#487): the issue is already created — never reject
    // on grammar. When a body-bearing issue type ships a non-empty body, surface
    // any missing spec sections (and the headings that would satisfy them) in an
    // additive `body_grammar` field, so the caller learns while the context to
    // amend is still loaded rather than at the /precheck gate. Absent/empty body
    // and non-spec types (pr/mr) get no field — no warning, no behavior change.
    const payload: Record<string, unknown> = { ok: true, ...result.data };
    if (BODY_GRAMMAR_TYPES.has(type) && typeof args.body === 'string' && args.body.trim().length > 0) {
      const grammar = validateBodyStructure(args.body);
      const bodyGrammar: Record<string, unknown> = {
        valid: grammar.valid,
        missing_sections: grammar.missing_sections,
      };
      if (grammar.missing_sections.length > 0) bodyGrammar.accepted_headings = grammar.accepted_headings;
      payload.body_grammar = bodyGrammar;
    }
    return envelope(payload);
  },
};

export default workItemHandler;
