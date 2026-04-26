/**
 * GitLab adapter — assembles per-method `<method>-gitlab.ts` implementations
 * into a single `PlatformAdapter` object.
 *
 * Story 1.2 ships this as an empty assembler: every method returns
 * `{platform_unsupported: true, hint: 'not yet migrated'}`. As each migration
 * story (Story 1.3 onward) lands, it replaces one method with the real
 * `<method>-gitlab.ts` implementation and removes the corresponding
 * `'not yet migrated'` stub.
 *
 * Some methods may stay as `platform_unsupported` permanently when the
 * underlying concept doesn't translate (e.g., `skip_train` semantics differ
 * between GitHub merge queues and GitLab merge trains). Those will return a
 * descriptive `hint` rather than a generic `'not yet migrated'`.
 */

import type { PlatformAdapter } from './types.js';
import { prCreateGitlab } from './pr-create-gitlab.js';

const stubMethod = async (_args: unknown) => ({
  platform_unsupported: true as const,
  hint: 'not yet migrated',
});

export const gitlabAdapter: PlatformAdapter = {
  prCreate: prCreateGitlab,
  prMerge: stubMethod,
  prMergeWait: stubMethod,
  prStatus: stubMethod,
  prDiff: stubMethod,
  prComment: stubMethod,
  prFiles: stubMethod,
  prList: stubMethod,
  prWaitCi: stubMethod,
  ciWaitRun: stubMethod,
  ciRunStatus: stubMethod,
  ciRunLogs: stubMethod,
  ciFailedJobs: stubMethod,
  ciRunsForBranch: stubMethod,
  labelCreate: stubMethod,
  labelList: stubMethod,
  workItem: stubMethod,
  ibm: stubMethod,
  epicSubIssues: stubMethod,
  specGet: stubMethod,
  specValidateStructure: stubMethod,
  specAcceptanceCriteria: stubMethod,
  specDependencies: stubMethod,
  fetchIssue: stubMethod,
};
