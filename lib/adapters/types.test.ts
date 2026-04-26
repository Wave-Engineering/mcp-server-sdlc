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

  test('Story 1.2 vacuous-pass: every method returns platform_unsupported', async () => {
    // When a real implementation lands (Story 1.3+), it removes that method
    // from this list. By Phase 3 close, this test should iterate zero methods.
    for (const method of PLATFORM_ADAPTER_METHODS) {
      const fn = (githubAdapter as unknown as Record<string, (args: unknown) => Promise<unknown>>)[method];
      const result = (await fn({})) as { platform_unsupported?: true; hint?: string };
      expect(result.platform_unsupported).toBe(true);
      expect(result.hint).toBe('not yet migrated');
    }
  });
});
