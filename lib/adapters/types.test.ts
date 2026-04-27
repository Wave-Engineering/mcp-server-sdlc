import { describe, test, expect } from 'bun:test';

import { PLATFORM_ADAPTER_METHODS } from './types.ts';
import { githubAdapter } from './github.ts';
import { gitlabAdapter } from './gitlab.ts';

// Contract test (R-04): every method listed in PLATFORM_ADAPTER_METHODS must
// be implemented by both adapters. Story 1.2's empty assemblers satisfy this
// vacuously — every method is the same `stubMethod` returning
// `{platform_unsupported: true, hint: 'not yet migrated'}`. As migration
// stories land real implementations, this test continues to enforce that no
// platform falls behind.
//
// The compile-time exhaustiveness check in `types.ts` (`_methodsExhaustive`)
// catches drift between PLATFORM_ADAPTER_METHODS and `keyof PlatformAdapter`.
// This runtime test catches the runtime case: the type system can be
// satisfied with `as` casts that lie about object shape.

describe('PlatformAdapter contract', () => {
  for (const method of PLATFORM_ADAPTER_METHODS) {
    test(`every method has GitHub impl — ${method}`, () => {
      const fn = (githubAdapter as unknown as Record<string, unknown>)[method];
      expect(typeof fn).toBe('function');
    });
  }

  for (const method of PLATFORM_ADAPTER_METHODS) {
    test(`every method has GitLab impl — ${method}`, () => {
      const fn = (gitlabAdapter as unknown as Record<string, unknown>)[method];
      expect(typeof fn).toBe('function');
    });
  }

  // Methods migrated to a real adapter implementation. Each migration story
  // (1.3 onward) appends here so the vacuous-pass test below stops asserting
  // `platform_unsupported` for that method. By Phase 3 close, this set
  // contains every method in PLATFORM_ADAPTER_METHODS and the test below
  // iterates zero methods.
  //
  // Story 1.3 (#240): prCreate
  // Story 1.4 (#241): prDiff
  // Story 1.5 (#242): prFiles
  // Story 1.6 (#243): prList
  // Story 1.7 (#244): prStatus
  // Story 1.8 (#245): prComment
  // Story 1.9 (#246): prWaitCi
  // Story 1.10 (#247): prMerge
  // Story 1.11 (#248): prMergeWait + fetchPrState (first hybrid sub-call)
  // Story 2.1 (#295): fetchIssue (keystone hybrid sub-call for Phase 2)
  // Story 2.11 (#305): ciFailedJobs
  // Story 2.12 (#306): ciRunLogs
  // Story 2.13 (#307): ciRunStatus
  // Story 2.14 (#308): ciRunsForBranch
  // Story 2.15 (#309): labelCreate
  // Story 2.16 (#310): labelList
  // Story 2.17 (#311): workItem (+ closes #281 cross-platform PR/MR asymmetry)
  // Story 2.18 (#312): ibm (+ fetchPrForBranch — `ibm` keystone sub-call)
  // Story 2.19 (#313): ci_wait_run hybrid migration (+ ciListRuns +
  //                    resolveBranchSha — `ci_wait_run` keystone sub-calls).
  //                    `ciWaitRun` itself remains stubbed — the handler routes
  //                    through the two sub-calls inside lib/ci-wait-run-poll.ts,
  //                    not through the top-level method.
  // Story 2.20 (#314): wave_previous_merged hybrid migration (+
  //                    fetchIssueClosure — the narrow state/closed-by-merged-PR
  //                    pair lifted from the handler-local `queryIssueClosure`).
  // Story 2.21 (#315): wave_reconcile_mrs hybrid migration (+
  //                    findMergedPrForBranchPrefix — the prefix-match merged
  //                    PR/MR lookup lifted from the handler-local
  //                    `queryGithubMergedPrs` / `queryGitlabMergedMrs` helpers;
  //                    also closes #282 by exposing a configurable `limit`
  //                    instead of the pre-migration hardcoded 50).
  // Story 2.22 (#316): wave_init hybrid migration (+ createBranch — the
  //                    KAHUNA branch-creation sub-call lifted from the
  //                    handler-local `createKahunaBranch` helper; also
  //                    promotes `resolveBranchShaGitlab` from a permanent
  //                    `platform_unsupported` stub to a real implementation
  //                    so GitLab can resolve the base-branch HEAD SHA).
  const MIGRATED_METHODS = new Set<string>([
    'prCreate',
    'prDiff',
    'prFiles',
    'prList',
    'prStatus',
    'prComment',
    'prWaitCi',
    'prMerge',
    'prMergeWait',
    'fetchPrState',
    'fetchIssue',
    'fetchIssueClosure',
    'fetchPrForBranch',
    'findMergedPrForBranchPrefix',
    'ciFailedJobs',
    'ciListRuns',
    'ciRunLogs',
    'ciRunStatus',
    'ciRunsForBranch',
    'labelCreate',
    'labelList',
    'resolveBranchSha',
    'workItem',
    'createBranch',
  ]);

  test('still-stubbed methods return platform_unsupported', async () => {
    const stubbed = PLATFORM_ADAPTER_METHODS.filter((m) => !MIGRATED_METHODS.has(m));
    for (const method of stubbed) {
      const fn = (githubAdapter as unknown as Record<string, (args: unknown) => Promise<unknown>>)[method];
      const result = (await fn({})) as { platform_unsupported?: true; hint?: string };
      expect(result.platform_unsupported).toBe(true);
      expect(result.hint).toBe('not yet migrated');
    }
  });
});
