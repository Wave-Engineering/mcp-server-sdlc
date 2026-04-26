// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-wait-ci-{github,gitlab}.ts;
// the platform-agnostic polling loop lives in lib/pr-wait-ci-poll.ts so it
// isn't duplicated per platform. See docs/handlers/origin-operations-guide.md
// for the canonical pattern and docs/platform-adapter-retrofit-devspec.md §5
// for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import {
  POLL_FLOOR_SEC,
  runPollLoop,
  type ChecksSnapshot,
  type Deps,
} from '../lib/pr-wait-ci-poll.js';
import { snapshotGithub, classifyRollupItem } from '../lib/adapters/pr-wait-ci-github.js';

const inputSchema = z
  .object({
    number: z.number().int().positive(),
    poll_interval_sec: z.number().int().optional().default(30),
    timeout_sec: z.number().int().positive().optional().default(1800),
    repo: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
      .optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

// Re-exported so the integration test (`tests/pr_wait_ci.test.ts`) can keep
// importing the polling-loop snapshot type and the GitHub-rollup classifier
// from the handler module. The classifier itself lives in the GitHub adapter
// (it encodes GitHub's check-rollup table); see `lib/adapters/pr-wait-ci-github.ts`.
export type { ChecksSnapshot };
export { classifyRollupItem };

/**
 * Test seam — drives the polling loop directly with injected `deps`. The
 * GitHub snapshot is the default for backward compat with pre-migration tests
 * that relied on a single platform path; tests that want the GitLab snapshot
 * inject their own `snapshotFn` via `deps`.
 */
export async function __runWithDeps(rawArgs: unknown, deps: Partial<Deps>) {
  const args = inputSchema.parse(rawArgs) as Input;
  if (args.poll_interval_sec < POLL_FLOOR_SEC) {
    throw new Error(
      `poll_interval_sec must be >= ${POLL_FLOOR_SEC} (got ${args.poll_interval_sec})`,
    );
  }
  const fullDeps: Deps = {
    snapshotFn: deps.snapshotFn ?? snapshotGithub,
    sleepFn: deps.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    nowFn: deps.nowFn ?? (() => Date.now()),
    heartbeatFn: deps.heartbeatFn,
  };
  return runPollLoop(args, fullDeps);
}

const prWaitCiHandler: HandlerDef = {
  name: 'pr_wait_ci',
  description:
    "Block until a PR/MR's check runs complete. Server-side polling with configurable interval (default 30s, min 5s) and timeout (default 1800s). Returns passed | failed | timed_out.",
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs) as Input;
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    if (args.poll_interval_sec < POLL_FLOOR_SEC) {
      return envelope({
        ok: false,
        error: `poll_interval_sec must be >= ${POLL_FLOOR_SEC} (got ${args.poll_interval_sec})`,
      });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.prWaitCi(args);

    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default prWaitCiHandler;
