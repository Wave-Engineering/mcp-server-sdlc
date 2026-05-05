/**
 * Schema-level tests for the shared `repo` parameter regex.
 *
 * Regression coverage for #290 — GitLab nested groups (`org/sub/.../repo`)
 * must validate alongside flat GitHub `owner/repo` slugs. The single-source
 * pattern lives in `lib/schemas/repo.ts`; every `pr_*` / `ci_*` / `wave_*` /
 * `label_*` / `work_item` handler imports `repoOptionalSchema` from there,
 * so a green test here protects all of them at once.
 */
import { describe, test, expect } from 'bun:test';
import {
  REPO_SLUG_REGEX,
  REPO_SLUG_ERROR,
  repoSchema,
  repoOptionalSchema,
} from './repo.ts';

describe('REPO_SLUG_REGEX', () => {
  describe('accepts flat owner/repo (GitHub-style, regression guard)', () => {
    test.each([
      ['Wave-Engineering/mcp-server-sdlc'],
      ['org/repo'],
      ['org123/repo-name'],
      ['org.dot/repo_underscore'],
      ['a/b'],
      ['a-b/c.d'],
      ['o.r.g/r.e.p.o'],
      // Hyphens, underscores, dots, digits are all valid in GitHub slugs.
      ['my-org/my_repo.v2'],
    ])('%s', (slug) => {
      expect(REPO_SLUG_REGEX.test(slug)).toBe(true);
    });
  });

  describe('accepts nested GitLab groups (#290 fix)', () => {
    test.each([
      ['org/sub/repo'],
      ['org/sub/subsub/repo'],
      // The exact failing case from #290 — 4-level deep group path.
      ['analogicdev/internal/tools/blueshift/blueshift-docmancer-ui'],
      ['a/b/c'],
      ['a/b/c/d/e/f/g'],
      ['Org-Name/Sub-Group/Repo.With.Dots'],
    ])('%s', (slug) => {
      expect(REPO_SLUG_REGEX.test(slug)).toBe(true);
    });
  });

  describe('rejects malformed input', () => {
    test.each([
      // No slash at all — bare owner.
      ['just-a-name'],
      [''],
      // Leading slash → empty first segment.
      ['/repo'],
      // Trailing slash → empty last segment.
      ['org/'],
      // Empty middle segment.
      ['org//repo'],
      // Whitespace.
      ['org /repo'],
      ['org/ repo'],
      // Shell metacharacters (defence-in-depth — adapters re-validate, but the
      // schema is the first line of defence).
      ['org/repo;rm -rf /'],
      ['org/repo`whoami`'],
      ['org/repo$(echo bad)'],
      ['org/repo|cat /etc/passwd'],
      // Other forbidden chars.
      ['org/repo!exclaim'],
      ['org/re@po'],
      ['org/re#po'],
      ['org/re po'],
    ])('%s', (slug) => {
      expect(REPO_SLUG_REGEX.test(slug)).toBe(false);
    });
  });
});

describe('repoSchema (Zod wrapper)', () => {
  test('parses a flat slug', () => {
    expect(repoSchema.parse('Wave-Engineering/mcp-server-sdlc')).toBe(
      'Wave-Engineering/mcp-server-sdlc',
    );
  });

  test('parses a nested-group slug', () => {
    const slug = 'analogicdev/internal/tools/blueshift/blueshift-docmancer-ui';
    expect(repoSchema.parse(slug)).toBe(slug);
  });

  test('rejects bare owner with the documented error message', () => {
    const r = repoSchema.safeParse('just-a-name');
    expect(r.success).toBe(false);
    if (!r.success) {
      // The Zod error wraps the regex message — confirm the contract.
      expect(r.error.issues[0].message).toBe(REPO_SLUG_ERROR);
      // Existing call-sites assert against the substring `owner/repo` —
      // make sure the new error message keeps that substring intact so
      // legacy tests don't break.
      expect(r.error.issues[0].message).toContain('owner/repo');
    }
  });
});

describe('repoOptionalSchema', () => {
  test('accepts undefined', () => {
    expect(repoOptionalSchema.parse(undefined)).toBe(undefined);
  });

  test('accepts a nested slug', () => {
    const slug = 'a/b/c/d';
    expect(repoOptionalSchema.parse(slug)).toBe(slug);
  });

  test('rejects an empty string (intentional — `optional` ≠ allow-empty)', () => {
    expect(repoOptionalSchema.safeParse('').success).toBe(false);
  });
});
