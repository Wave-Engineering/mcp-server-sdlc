/**
 * Stubs for the `precheck` gate's reads (#592), on the shared child_process
 * mock (`onExec`, first match wins: call these BEFORE a test's own stubs).
 *
 * Tests that predate the gate exercise adapter mechanics (argv shape, queue
 * paths, GitLab polls), not the gate. They register one of these in
 * `beforeEach` so the gate is satisfied and gets out of the way:
 *
 *   - `stubPrecheckPassThrough()`: pr_merge / pr_merge_wait. The gate's PR/MR
 *     snapshot is an integration pair (head `kahuna/*`), which the gate passes
 *     through untouched, so the adapter sees exactly the caller's args.
 *   - `stubPrecheckPass()`: pr_create. The head branch's platform SHA carries
 *     `precheck` = success; callers also pass `VALID_SQUASH_MESSAGE`.
 *
 * The gate itself is tested in tests/precheck_gate.test.ts.
 */

import { onExec } from './mock-child-process.ts';

export const STUB_SHA = 'a'.repeat(40);

export const VALID_SQUASH_MESSAGE =
  'feat(pr): a deliberate squash commit\n\nWhat lands, said once.\n\nCloses #592\n\nCo-Authored-By: Claude <noreply@anthropic.com>';

/** The gate's `gh pr view` and GitLab `projects/:id/merge_requests/<n>` reads → an integration pair. */
export function stubPrecheckPassThrough(): void {
  onExec(
    '--json id,headRefOid',
    JSON.stringify({
      id: 'PR_stub',
      headRefOid: STUB_SHA,
      headRefName: 'kahuna/0-legacy',
      baseRefName: 'main',
      title: 'stub',
      body: '',
      isDraft: false,
      state: 'OPEN',
      isCrossRepository: false,
    }),
  );
  onExec(
    'glab api projects/:id/merge_requests/',
    JSON.stringify({
      iid: 1,
      sha: STUB_SHA,
      source_branch: 'kahuna/0-legacy',
      target_branch: 'main',
      title: 'stub',
      description: '',
      draft: false,
      state: 'opened',
      source_project_id: 1,
      target_project_id: 1,
    }),
  );
}

/** The gate's remote-branch and status reads → `precheck` = success, on both platforms. */
export function stubPrecheckPass(): void {
  onExec('/git/ref/heads/', JSON.stringify({ object: { sha: STUB_SHA } }));
  onExec('/status?per_page=100', JSON.stringify({ state: 'success', statuses: [{ context: 'precheck', state: 'success' }] }));
  onExec('/repository/branches/', JSON.stringify({ name: 'b', commit: { id: STUB_SHA } }));
  onExec('/statuses?name=precheck', JSON.stringify([{ id: 1, name: 'precheck', status: 'success' }]));
}
