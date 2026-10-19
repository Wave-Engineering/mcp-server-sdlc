// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-create-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import {
  currentBranch,
  formatSquashCommit,
  isIntegrationPair,
  parseSquashBlock,
  remoteHead,
  requirePrecheckPass,
  validateSquashMessage,
  withSquashBlock,
} from '../lib/precheck-gate.js';

const inputSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string().min(1, 'body must be a non-empty string'),
  // #592: the exact commit that will land, required outside integration pairs.
  // Stored in the body as `## Squash commit`; pr_merge squashes from it.
  squash_message: z.string().min(1).optional(),
  // base is optional — when omitted, the adapter resolves the repo's
  // default branch so /scp + sibling skills don't need to probe it (#159).
  base: z.string().min(1).optional(),
  head: z.string().optional(),
  draft: z.boolean().optional().default(false),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prCreateHandler: HandlerDef = {
  name: 'pr_create',
  description:
    'Create a pull request (GitHub) or merge request (GitLab) for the current branch. Returns the normalized {number, url, state, head, base}. ' +
    'squash_message is REQUIRED (#592): the exact squash commit that will land — subject `type(scope): description` ' +
    '(≤72 chars; type feat|fix|doc|style|refactor|test|chore), a blank line, a body with `Closes #N`, and a ' +
    '`Co-Authored-By:` trailer. It is appended to the body as `## Squash commit`, and pr_merge squashes from it. ' +
    'A non-draft create also requires the `precheck` commit status = success on the head branch\'s SHA as the ' +
    'platform has it (run /precheck); draft: true skips that check, since a draft cannot merge. Integration pairs ' +
    '(head kahuna/* or campaign/*, or base kahuna/*) are exempt from both: the wave trust gate governs them.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });

    // #592: the precheck gate. `base` omitted means the default branch, which
    // is never an integration branch, so '' is the right stand-in for the
    // exemption check.
    const head = args.head ?? currentBranch();
    const exempt = isIntegrationPair(head, args.base ?? '');
    let body = args.body;
    if (args.squash_message !== undefined || !exempt) {
      if (args.squash_message === undefined) {
        return envelope({
          ok: false,
          code: 'squash_message_required',
          error:
            'pr_create: squash_message is required — the exact squash commit that will land ' +
            '(subject, blank line, body with `Closes #N`, `Co-Authored-By:` trailer).',
        });
      }
      const v = validateSquashMessage(args.squash_message);
      if (!v.ok) return envelope({ ok: false, code: 'squash_message_invalid', error: `pr_create: ${v.error}` });
      body = withSquashBlock(args.body, v.commit);
      // pr_merge reads this body back; refuse now what it would refuse then.
      const back = parseSquashBlock(body);
      if (!back.ok || formatSquashCommit(back.commit) !== formatSquashCommit(v.commit)) {
        return envelope({
          ok: false,
          code: 'squash_block_ambiguous',
          error: 'pr_create: the body already carries a `## Squash commit` heading that is not a single block; remove it from body and pass the commit as squash_message.',
        });
      }
    }
    if (!exempt && !args.draft) {
      if (head === '') {
        return envelope({ ok: false, code: 'precheck_unreadable', error: 'pr_create: no head branch (detached HEAD); pass head' });
      }
      const at = await remoteHead(adapter, head, args.repo, 'pr_create');
      if (!at.ok) return envelope({ ok: false, ...at.refusal });
      const refusal = await requirePrecheckPass(adapter, at.sha, args.repo, 'pr_create');
      if (refusal !== undefined) {
        return envelope({ ok: false, ...refusal, error: `${refusal.error} Or open it with draft: true.` });
      }
    }

    const { squash_message: _squash, ...createArgs } = args;
    const result = await adapter.prCreate({ ...createArgs, body });

    // Per dev spec §4.4 step 4: surface `platform_unsupported` as a typed
    // signal alongside `ok: true` — NOT as an error. The dispatch succeeded;
    // the platform just doesn't have the concept. Callers branch on the
    // discriminator instead of confusing it with a runtime failure.
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default prCreateHandler;
