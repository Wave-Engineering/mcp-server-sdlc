// KAHUNA epic-final gate: opens (or returns) the kahuna → target_branch MR.
// Idempotent on (kahuna_branch, target_branch). Platform-agnostic dispatcher —
// `findExistingPr` + `prCreate` go through `getAdapter()`; body composition and
// SHA hashing live in `lib/wave-finalize.ts`. Story 2.23 (#317).
//
// `target_branch` is REQUIRED — no default of any kind (#503). It was a static
// `.default('main')`, then (#472/#473) the repo's live default branch resolved
// via the adapter. Both are wrong for the same reason: the default's *value* is
// "the protected branch", and this handler's job is to open a MERGE TARGET.
// Post-claudecode-workflow#1052 a campaign integrates each wave onto the campaign
// branch and writes the protected branch exactly once, at the DoD gate — so a wave
// that reaches this handler with `target_branch` omitted must fail loudly, not
// silently promote to trunk. There is no safe guess for which branch a wave
// integrates onto; only the caller knows whether it is mid-campaign or at the DoD.
// (#472's own hazard — a repo whose default is e.g. release/1.0.0 — is unaffected:
// a caller that wants the default branch resolves it and passes it.)

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { branchExistsOnRemote } from '../lib/shared/git-remote.js';
import { emitStateEvent } from '../lib/flightdeck_emit.js';
import {
  assembleBody, assembleBodyFromState, defaultArtifactsDir, epicSlugFromBranch, hashBody,
  projectDir, resolveArtifactsDir,
} from '../lib/wave-finalize.js';

const inputSchema = z.object({
  root: z.string().optional(),
  plan_id: z.number().int().positive(),
  kahuna_branch: z.string().min(1),
  // REQUIRED — no default (#503). A default here means "merge to the protected
  // branch", which is exactly the early-trunk-write #1052 removed.
  target_branch: z.string().min(1),
  body_artifacts_dir: z.string().optional(),
});

const envelope = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

// Re-export for existing tests in `tests/wave_finalize.test.ts`.
export { assembleBody } from '../lib/wave-finalize.js';

const waveFinalizeHandler: HandlerDef = {
  name: 'wave_finalize',
  description:
    'Open (or return the existing) kahuna→target_branch MR for a KAHUNA epic. ' +
    'Idempotent on (kahuna_branch, target_branch). `target_branch` is REQUIRED and has no default (#503) — ' +
    'inside a campaign a wave integrates onto the campaign branch, and the protected branch is written once at the DoD gate; ' +
    'a caller that wants the repo default must resolve it and pass it explicitly. ' +
    'The MR body is assembled from wavebus artifacts under `body_artifacts_dir` (default: /tmp/wavemachine/<slug>/); ' +
    'when those are absent (e.g. wave_complete cleanup wiped them on the last wave), the handler falls back to durable wave-status state ' +
    '(`<project>/.claude/status/{phases-waves.json,state.json}`) to re-derive the body from plan + recorded mr_urls. ' +
    'Returns kahuna_branch_not_found if the branch is absent on the remote; no_artifacts if neither the bus nor durable state yields any issues. ' +
    'body_sha is a SHA-256 digest of the assembled body for drift detection.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try { args = inputSchema.parse(rawArgs); }
    catch (err) { return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
    try {
      const cwd = projectDir(args.root);
      const resolved = resolveArtifactsDir(args.body_artifacts_dir, defaultArtifactsDir(args.kahuna_branch), cwd);
      if (!resolved.ok) return envelope({ ok: false, error: resolved.error });
      const adapter = getAdapter();
      // target_branch is schema-required (#503) — nothing to resolve, nothing to
      // guess. The zod parse above rejected an omitted or empty value.
      const targetBranch = args.target_branch;
      // Try the bus first; fall back to durable wave-status state when the
      // bus has been cleaned up (#415). assembleBodyFromState consults
      // `<project>/.claude/status/{phases-waves.json,state.json}`.
      const composeBody = async () => {
        const fromBus = await assembleBody(resolved.path, args.plan_id, args.kahuna_branch, targetBranch);
        if (fromBus.issueCount > 0) return fromBus;
        return await assembleBodyFromState(cwd, args.plan_id, args.kahuna_branch, targetBranch);
      };
      // Idempotency first (per devspec §5.1.1 step 1). Covers the post-merge
      // edge case where the kahuna branch was deleted after the MR was opened.
      const existing = await adapter.findExistingPr({ head: args.kahuna_branch, base: targetBranch, state: 'open', cwd });
      if ('platform_unsupported' in existing) return envelope({ ok: false, error: `findExistingPr unsupported: ${existing.hint}` });
      if (!existing.ok) return envelope({ ok: false, code: existing.code, error: existing.error });
      if (existing.data !== null) {
        // body_sha is empty when neither bus nor durable state has issues —
        // legitimate post-cleanup state on a brand-new PR.
        const { body, issueCount } = await composeBody();
        // FlightDeck emit (S1.5, additive) — promote step for the existing
        // kahuna finalize MR. Fire-and-forget; response unchanged.
        emitStateEvent(cwd, 'step', {
          action: 'promote',
          label: 'wave_finalize',
          detail: { number: existing.data.number, plan_id: args.plan_id, target: targetBranch, created: false },
        });
        return envelope({ ok: true, number: existing.data.number, url: existing.data.url, state: 'open', created: false, body_sha: issueCount > 0 ? hashBody(body) : '' });
      }
      if (!branchExistsOnRemote(cwd, args.kahuna_branch)) return envelope({ ok: false, error: 'kahuna_branch_not_found' });
      const { body, issueCount } = await composeBody();
      if (issueCount === 0) return envelope({ ok: false, error: 'no_artifacts' });
      const title = `plan(#${args.plan_id}): ${epicSlugFromBranch(args.kahuna_branch)} — kahuna to ${targetBranch}`;
      const created = await adapter.prCreate({ title, body, base: targetBranch, head: args.kahuna_branch, cwd });
      if ('platform_unsupported' in created) return envelope({ ok: false, error: `prCreate unsupported: ${created.hint}` });
      if (!created.ok) return envelope({ ok: false, code: created.code, error: created.error });
      // FlightDeck emit (S1.5, additive) — promote step for the newly-opened
      // kahuna→target MR, plus a coded self-approval concern: the epic opens its
      // own promotion MR (the KAHUNA sandbox self-approval shape). Fire-and-
      // forget; response and control flow are unchanged.
      emitStateEvent(cwd, 'step', {
        action: 'promote',
        label: 'wave_finalize',
        detail: { number: created.data.number, plan_id: args.plan_id, target: targetBranch, created: true },
      });
      emitStateEvent(cwd, 'concern', {
        concernKind: 'self-approval',
        source: 'coded',
        label: 'kahuna epic-final MR opened',
        detail: { number: created.data.number, plan_id: args.plan_id, target: targetBranch },
      });
      return envelope({ ok: true, number: created.data.number, url: created.data.url, state: 'open', created: true, body_sha: hashBody(body) });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveFinalizeHandler;
