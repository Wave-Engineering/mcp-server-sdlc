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
import { ciFailedJobsGithub } from './ci-failed-jobs-github.js';
import { ciListRunsGithub } from './ci-list-runs-github.js';
import { ciRunLogsGithub } from './ci-run-logs-github.js';
import { ciRunStatusGithub } from './ci-run-status-github.js';
import { ciRunsForBranchGithub } from './ci-runs-for-branch-github.js';
import { fetchIssueGithub } from './fetch-issue-github.js';
import { fetchIssueClosureGithub } from './fetch-issue-closure-github.js';
import { fetchPrForBranchGithub } from './fetch-pr-for-branch-github.js';
import { fetchPrStateGithub } from './fetch-pr-state-github.js';
import { findMergedPrForBranchPrefixGithub } from './find-merged-pr-for-branch-prefix-github.js';
import { resolveBranchShaGithub } from './resolve-branch-sha-github.js';
import { labelCreateGithub } from './label-create-github.js';
import { labelListGithub } from './label-list-github.js';
import { prCommentGithub } from './pr-comment-github.js';
import { prCreateGithub } from './pr-create-github.js';
import { prDiffGithub } from './pr-diff-github.js';
import { prFilesGithub } from './pr-files-github.js';
import { prListGithub } from './pr-list-github.js';
import { prMergeGithub } from './pr-merge-github.js';
import { prMergeWaitGithub } from './pr-merge-wait-github.js';
import { prStatusGithub } from './pr-status-github.js';
import { prWaitCiGithub } from './pr-wait-ci-github.js';
import { workItemGithub } from './work-item-github.js';

const stubMethod = async (_args: unknown) => ({
  platform_unsupported: true as const,
  hint: 'not yet migrated',
});

export const githubAdapter: PlatformAdapter = {
  prCreate: prCreateGithub,
  prMerge: prMergeGithub,
  prMergeWait: prMergeWaitGithub,
  prStatus: prStatusGithub,
  prDiff: prDiffGithub,
  prComment: prCommentGithub,
  prFiles: prFilesGithub,
  prList: prListGithub,
  prWaitCi: prWaitCiGithub,
  ciWaitRun: stubMethod,
  ciRunStatus: ciRunStatusGithub,
  ciRunLogs: ciRunLogsGithub,
  ciFailedJobs: ciFailedJobsGithub,
  ciRunsForBranch: ciRunsForBranchGithub,
  labelCreate: labelCreateGithub,
  labelList: labelListGithub,
  workItem: workItemGithub,
  ibm: stubMethod,
  epicSubIssues: stubMethod,
  specGet: stubMethod,
  specValidateStructure: stubMethod,
  specAcceptanceCriteria: stubMethod,
  specDependencies: stubMethod,
  fetchIssue: fetchIssueGithub,
  fetchPrState: fetchPrStateGithub,
  fetchPrForBranch: fetchPrForBranchGithub,
  fetchIssueClosure: fetchIssueClosureGithub,
  findMergedPrForBranchPrefix: findMergedPrForBranchPrefixGithub,
  ciListRuns: ciListRunsGithub,
  resolveBranchSha: resolveBranchShaGithub,
};
