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
  const MIGRATED_METHODS = new Set<string>(['prCreate', 'prDiff', 'prFiles', 'prList', 'prStatus', 'prComment', 'prWaitCi']);

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
