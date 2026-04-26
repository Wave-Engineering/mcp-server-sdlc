/**
 * GitHub adapter — assembles per-method `<method>-github.ts` implementations
 * into a single `PlatformAdapter` object.
 *
 * Story 1.2 ships this as an empty assembler: every method returns
 * `{platform_unsupported: true, hint: 'not yet migrated'}`. As each migration
 * story (Story 1.3 onward) lands, it replaces one method with the real
 * `<method>-github.ts` implementation and removes the corresponding
 * `'not yet migrated'` stub.
 *
 * The contract test (`types.test.ts`) enforces — at runtime — that every
 * method listed in `PLATFORM_ADAPTER_METHODS` is present on this object. The
 * `: PlatformAdapter` type annotation enforces the same at compile time.
 */

import type { PlatformAdapter } from './types.js';
import { prCommentGithub } from './pr-comment-github.js';
import { prCreateGithub } from './pr-create-github.js';
import { prDiffGithub } from './pr-diff-github.js';
import { prFilesGithub } from './pr-files-github.js';
import { prListGithub } from './pr-list-github.js';
import { prStatusGithub } from './pr-status-github.js';
import { prWaitCiGithub } from './pr-wait-ci-github.js';

const stubMethod = async (_args: unknown) => ({
  platform_unsupported: true as const,
  hint: 'not yet migrated',
});

export const githubAdapter: PlatformAdapter = {
  prCreate: prCreateGithub,
  prMerge: stubMethod,
  prMergeWait: stubMethod,
  prStatus: prStatusGithub,
  prDiff: prDiffGithub,
  prComment: prCommentGithub,
  prFiles: prFilesGithub,
  prList: prListGithub,
  prWaitCi: prWaitCiGithub,
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
