// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching + the phased state machine live in
// lib/ci-wait-run-poll.ts and lib/adapters/ci-list-runs-{github,gitlab}.ts /
// resolve-branch-sha-{github,gitlab}.ts per Story 2.19 (#313). See
// docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';
import {
  waitForRun,
  defaultSleep,
  type WaitResult,
} from '../lib/ci-wait-run-poll.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import { emitStateEvent, scopeRoot } from '../lib/flightdeck_emit.js';

const inputSchema = z
  .object({
    ref: z.string().min(1, 'ref must be a non-empty string (commit SHA or branch name)'),
    workflow_name: z.string().optional(),
    poll_interval_sec: z.number().int().positive().optional(),
    timeout_sec: z.number().int().positive().optional(),
    // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
    repo: repoOptionalSchema,
    expected_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i, 'expected_sha must be a 40-char hex commit SHA')
      .optional(),
    require_merge_result: z.boolean().optional(),
    /** PR number (GitHub) / MR iid (GitLab). Required with require_merge_result. */
    pr_number: z.number().int().positive().optional(),
  })
  .strict()
  .refine((a) => !a.require_merge_result || a.pr_number !== undefined, {
    message:
      'require_merge_result needs pr_number: without the PR/MR number there is no way to prove the merge-result run belongs to the CURRENT head, so a green run for a previous commit could satisfy the gate.',
    path: ['pr_number'],
  });

// --- injectable sleep (tests replace with a no-op) ---
let sleepFn: (ms: number) => Promise<void> = defaultSleep;
export function __setSleep(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}
export function __resetSleep(): void {
  sleepFn = defaultSleep;
}

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

// WaitResult → response envelope. Drops undefined fields so the shape matches
// the pre-migration handler byte-for-byte (optional fields omitted, not null).
function resultToEnvelope(result: WaitResult) {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (v !== undefined) payload[k] = v;
  }
  return envelope(payload);
}

const ciWaitRunHandler: HandlerDef = {
  name: 'ci_wait_run',
  description:
    "Block on a CI workflow/pipeline run for a commit SHA or branch ref, polling server-side until it completes or times out. Returns the final status without burning agent tokens in a busy-wait loop. Set `require_merge_result: true` to accept ONLY a run that validated the merge result AND belongs to the PR/MR\u2019s current head (requires `pr_number`). GitHub: a `pull_request` run whose head_sha is the PR head. GitLab: a `refs/merge-requests/N/merge` pipeline that GitLab reports as the MR\u2019s `head_pipeline` \u2014 a detached (`/head`) or merge-train (`/train`) pipeline is NOT a merge result — a branch pipeline, or a skipped one, then yields `final_status: \"not_merge_result\"` instead of a misleading success. Use it for merge gates; leave it off when you legitimately want the branch pipeline (e.g. watching `main` after a merge).",
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    const platform = detectPlatform();
    const result = await waitForRun(
      { ...args, platform },
      { adapter: getAdapter({ repo: args.repo }), sleep: sleepFn, now: Date.now },
    );
    // FlightDeck emit (S1.5, additive) — a ci_wait event records the terminal
    // status of the blocked wait. Scope to the handler's explicit repo (else a
    // guarded project dir) so scope resolution can't throw outside the emit
    // guard. Fire-and-forget; envelope unchanged.
    emitStateEvent(scopeRoot(args.repo), 'ci_wait', {
      label: String((result as { final_status?: string }).final_status ?? 'unknown'),
      detail: { ref: args.ref, workflow_name: args.workflow_name },
    });
    return resultToEnvelope(result);
  },
};

export default ciWaitRunHandler;
