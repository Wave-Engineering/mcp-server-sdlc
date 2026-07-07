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
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
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
  })
  .strict();

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
    "Block on a CI workflow/pipeline run for a commit SHA or branch ref, polling server-side until it completes or times out. Returns the final status without burning agent tokens in a busy-wait loop. Merge-queue-only GitHub repos (workflows gated on `merge_group`/`pull_request` with no `push` trigger) are handled specially: if no push-triggered runs exist for the ref but a `merge_group` run matches its HEAD SHA, returns `final_status: \"not_applicable\"` with `reason: \"merge_group_validated\"` — distinguishable from a real failure.",
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
      { ...args, cwd_repo_slug: args.repo ?? parseRepoSlug(), platform },
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
