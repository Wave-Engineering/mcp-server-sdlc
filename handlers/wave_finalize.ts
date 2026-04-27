// KAHUNA epic-final gate: opens (or returns) the kahuna → target_branch MR.
// Idempotent on (kahuna_branch, target_branch). Platform-agnostic dispatcher
// — `findExistingPr` + `prCreate` go through `getAdapter()`; body composition
// and SHA hashing live in `lib/wave-finalize.ts`. Story 2.23 (#317).

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { branchExistsOnRemote } from '../lib/shared/git-remote.js';
import {
  assembleBody, defaultArtifactsDir, epicSlugFromBranch, hashBody,
  projectDir, resolveArtifactsDir,
} from '../lib/wave-finalize.js';

const inputSchema = z.object({
  root: z.string().optional(),
  plan_id: z.number().int().positive(),
  kahuna_branch: z.string().min(1),
  target_branch: z.string().min(1).default('main'),
  body_artifacts_dir: z.string().optional(),
});

const envelope = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

// Re-export for existing tests in `tests/wave_finalize.test.ts`.
export { assembleBody } from '../lib/wave-finalize.js';

const waveFinalizeHandler: HandlerDef = {
  name: 'wave_finalize',
  description:
    'Open (or return the existing) kahuna→target_branch MR for a KAHUNA epic. ' +
    'Idempotent on (kahuna_branch, target_branch). The MR body is assembled from wavebus artifacts under `body_artifacts_dir` (default: /tmp/wavemachine/<slug>/). ' +
    'Returns kahuna_branch_not_found if the branch is absent on the remote; no_artifacts if the artifact tree contains no flight results. ' +
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
      // Idempotency first (per devspec §5.1.1 step 1). Covers the post-merge
      // edge case where the kahuna branch was deleted after the MR was opened.
      const existing = await adapter.findExistingPr({ head: args.kahuna_branch, base: args.target_branch, state: 'open' });
      if ('platform_unsupported' in existing) return envelope({ ok: false, error: `findExistingPr unsupported: ${existing.hint}` });
      if (!existing.ok) return envelope({ ok: false, error: existing.error });
      if (existing.data !== null) {
        // body_sha is empty when artifacts are absent — legitimate post-cleanup state.
        const { body, issueCount } = await assembleBody(resolved.path, args.plan_id, args.kahuna_branch, args.target_branch);
        return envelope({ ok: true, number: existing.data.number, url: existing.data.url, state: 'open', created: false, body_sha: issueCount > 0 ? hashBody(body) : '' });
      }
      if (!branchExistsOnRemote(cwd, args.kahuna_branch)) return envelope({ ok: false, error: 'kahuna_branch_not_found' });
      const { body, issueCount } = await assembleBody(resolved.path, args.plan_id, args.kahuna_branch, args.target_branch);
      if (issueCount === 0) return envelope({ ok: false, error: 'no_artifacts' });
      const title = `plan(#${args.plan_id}): ${epicSlugFromBranch(args.kahuna_branch)} — kahuna to ${args.target_branch}`;
      const created = await adapter.prCreate({ title, body, base: args.target_branch, head: args.kahuna_branch });
      if ('platform_unsupported' in created) return envelope({ ok: false, error: `prCreate unsupported: ${created.hint}` });
      if (!created.ok) return envelope({ ok: false, error: created.error });
      return envelope({ ok: true, number: created.data.number, url: created.data.url, state: 'open', created: true, body_sha: hashBody(body) });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveFinalizeHandler;
