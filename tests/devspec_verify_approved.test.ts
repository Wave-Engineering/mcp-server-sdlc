import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock child_process BEFORE importing the handler. The handler uses
// execSync('cat ...') to read the Dev Spec file, keeping with the
// codebase's child_process.execSync convention.
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/devspec_verify_approved.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Build an execSync stub that returns the given file contents for any
 * `cat ...` command, and throws for anything else. This matches how
 * the handler shells out to read the Dev Spec file.
 */
function catReturning(contents: string) {
  return (cmd: string) => {
    if (cmd.startsWith('cat')) return contents;
    return '';
  };
}

function catThrowing(msg: string) {
  return (cmd: string): string => {
    if (cmd.startsWith('cat')) throw new Error(msg);
    return '';
  };
}

const APPROVED_SPEC = `# Example Dev Spec

<!-- DEV-SPEC-APPROVAL
approved: true
approved_by: BJ
approved_at: 2026-04-04T12:00:00Z
finalization_score: 7/7
-->

## Section 1: Overview

Body text here.
`;

const UNAPPROVED_SPEC_NO_BLOCK = `# Example Dev Spec

## Section 1: Overview

No approval block anywhere in this file.
`;

const UNAPPROVED_SPEC_FALSE = `# Example Dev Spec

<!-- DEV-SPEC-APPROVAL
approved: false
approved_by: BJ
approved_at: 2026-04-04T12:00:00Z
finalization_score: 4/7
-->

## Section 1: Overview
`;

const APPROVED_SPEC_MINIMAL = `<!-- DEV-SPEC-APPROVAL
approved: true
-->

# Minimal
`;

const MALFORMED_UNTERMINATED = `# Spec

<!-- DEV-SPEC-APPROVAL
approved: true
approved_by: BJ

## Section 1: Overview
`;

const MALFORMED_BAD_LINE = `# Spec

<!-- DEV-SPEC-APPROVAL
approved: true
this line has no colon
-->
`;

const MALFORMED_MISSING_APPROVED = `# Spec

<!-- DEV-SPEC-APPROVAL
approved_by: BJ
approved_at: 2026-04-04T12:00:00Z
-->
`;

const MALFORMED_APPROVED_NON_BOOL = `# Spec

<!-- DEV-SPEC-APPROVAL
approved: maybe
-->
`;

const MALFORMED_EMPTY_BLOCK = `# Spec

<!-- DEV-SPEC-APPROVAL

-->
`;

describe('devspec_verify_approved handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('devspec_verify_approved');
    expect(typeof handler.description).toBe('string');
    expect(typeof handler.execute).toBe('function');
  });

  test('returns approved:true for a properly approved file', async () => {
    execMockFn = catReturning(APPROVED_SPEC);
    const result = await handler.execute({ path: 'docs/my-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('docs/my-devspec.md');
    expect(parsed.approved).toBe(true);
    expect(parsed.approved_by).toBe('BJ');
    expect(parsed.approved_at).toBe('2026-04-04T12:00:00Z');
    expect(parsed.finalization_score).toBe('7/7');
  });

  test('returns approved:true with only required field (other metadata optional)', async () => {
    execMockFn = catReturning(APPROVED_SPEC_MINIMAL);
    const result = await handler.execute({ path: 'docs/minimal-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.approved).toBe(true);
    expect(parsed.approved_by).toBeUndefined();
    expect(parsed.approved_at).toBeUndefined();
    expect(parsed.finalization_score).toBeUndefined();
  });

  test('returns approved:false for an unapproved file (no block)', async () => {
    execMockFn = catReturning(UNAPPROVED_SPEC_NO_BLOCK);
    const result = await handler.execute({ path: 'docs/draft-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('docs/draft-devspec.md');
    expect(parsed.approved).toBe(false);
    expect(parsed.approved_by).toBeUndefined();
    expect(parsed.approved_at).toBeUndefined();
    expect(parsed.finalization_score).toBeUndefined();
  });

  test('returns approved:false when block has approved:false (metadata still populated)', async () => {
    execMockFn = catReturning(UNAPPROVED_SPEC_FALSE);
    const result = await handler.execute({ path: 'docs/rejected-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.approved).toBe(false);
    expect(parsed.approved_by).toBe('BJ');
    expect(parsed.approved_at).toBe('2026-04-04T12:00:00Z');
    expect(parsed.finalization_score).toBe('4/7');
  });

  test('handles malformed block — unterminated comment', async () => {
    execMockFn = catReturning(MALFORMED_UNTERMINATED);
    const result = await handler.execute({ path: 'docs/bad-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('malformed');
    expect(parsed.error).toContain('unterminated');
  });

  test('handles malformed block — line without colon', async () => {
    execMockFn = catReturning(MALFORMED_BAD_LINE);
    const result = await handler.execute({ path: 'docs/bad-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('malformed');
    expect(parsed.error).toContain('this line has no colon');
  });

  test('handles malformed block — missing approved field', async () => {
    execMockFn = catReturning(MALFORMED_MISSING_APPROVED);
    const result = await handler.execute({ path: 'docs/bad-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('missing required `approved`');
  });

  test('handles malformed block — approved is not a boolean', async () => {
    execMockFn = catReturning(MALFORMED_APPROVED_NON_BOOL);
    const result = await handler.execute({ path: 'docs/bad-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('must be');
    expect(parsed.error).toContain('maybe');
  });

  test('handles malformed block — empty block body', async () => {
    execMockFn = catReturning(MALFORMED_EMPTY_BLOCK);
    const result = await handler.execute({ path: 'docs/bad-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('empty');
  });

  test('handles missing file with structured error', async () => {
    execMockFn = catThrowing('cat: nonexistent: No such file or directory');
    const result = await handler.execute({ path: '/tmp/nonexistent-devspec.md' });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found or unreadable');
    expect(parsed.error).toContain('/tmp/nonexistent-devspec.md');
  });

  test('schema validation — rejects missing path', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema validation — rejects empty path', async () => {
    const result = await handler.execute({ path: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('is case-insensitive for approved: true/TRUE', async () => {
    execMockFn = catReturning(`<!-- DEV-SPEC-APPROVAL
approved: TRUE
-->
`);
    const result = await handler.execute({ path: 'docs/caps-devspec.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.approved).toBe(true);
  });
});
