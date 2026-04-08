import { describe, test, expect } from 'bun:test';

const { default: handler } = await import('../handlers/devspec_approve.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

let counter = 0;
async function writeTempFile(content: string): Promise<string> {
  counter += 1;
  const path = `/tmp/devspec-approve-${Date.now()}-${counter}-${Math.floor(Math.random() * 1e12)}.md`;
  await Bun.write(path, content);
  return path;
}

async function readFile(path: string): Promise<string> {
  return await Bun.file(path).text();
}

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const FRESH_SPEC = `# Dev Spec: Example

## 1. Overview

Some overview content.

## 2. Acceptance Criteria

- [ ] Criterion A
`;

const SPEC_WITH_FRONTMATTER = `---
title: Example
owner: bj
---

# Dev Spec: Example

## 1. Overview

Content here.
`;

const SPEC_WITH_EXISTING_APPROVAL = `# Dev Spec: Example

<!-- DEV-SPEC-APPROVAL
approved: true
approved_by: alice
approved_at: 2025-01-01T00:00:00Z
finalization_score: 5/7
-->

## 1. Overview

Content.
`;

describe('devspec_approve handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('devspec_approve');
    expect(typeof handler.execute).toBe('function');
  });

  test('inserts new approval block in a fresh file', async () => {
    const path = await writeTempFile(FRESH_SPEC);
    const result = await handler.execute({ path, approver: 'bj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(path);
    expect(parsed.approved_by).toBe('bj');
    expect(parsed.finalization_score).toBe('7/7');

    const updated = await readFile(path);
    expect(updated).toContain('<!-- DEV-SPEC-APPROVAL');
    expect(updated).toContain('approved: true');
    expect(updated).toContain('approved_by: bj');
    expect(updated).toContain('finalization_score: 7/7');
    expect(updated).toContain('-->');
    // Block is at the top, before Section 1
    const blockIdx = updated.indexOf('<!-- DEV-SPEC-APPROVAL');
    const section1Idx = updated.indexOf('## 1. Overview');
    expect(blockIdx).toBeLessThan(section1Idx);
    // Original body preserved
    expect(updated).toContain('Some overview content.');
  });

  test('replaces existing approval block with updated values', async () => {
    const path = await writeTempFile(SPEC_WITH_EXISTING_APPROVAL);
    const result = await handler.execute({
      path,
      approver: 'bj',
      finalization_score: '7/7',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);

    const updated = await readFile(path);
    // New values present
    expect(updated).toContain('approved_by: bj');
    expect(updated).toContain('finalization_score: 7/7');
    // Old values gone
    expect(updated).not.toContain('approved_by: alice');
    expect(updated).not.toContain('finalization_score: 5/7');
    expect(updated).not.toContain('2025-01-01T00:00:00Z');
    // Exactly one approval block (no duplicates)
    const matches = updated.match(/<!-- DEV-SPEC-APPROVAL/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
    // Section 1 still present
    expect(updated).toContain('## 1. Overview');
  });

  test('handles file with frontmatter correctly — block goes after frontmatter', async () => {
    const path = await writeTempFile(SPEC_WITH_FRONTMATTER);
    const result = await handler.execute({ path, approver: 'bj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);

    const updated = await readFile(path);
    // Frontmatter preserved at the very top
    expect(updated.startsWith('---\n')).toBe(true);
    expect(updated).toContain('title: Example');
    expect(updated).toContain('owner: bj');

    // Block appears after closing frontmatter and before the H1
    const frontmatterCloseIdx = updated.indexOf('\n---\n') + '\n---\n'.length;
    const blockIdx = updated.indexOf('<!-- DEV-SPEC-APPROVAL');
    const h1Idx = updated.indexOf('# Dev Spec: Example');
    expect(blockIdx).toBeGreaterThanOrEqual(frontmatterCloseIdx);
    expect(blockIdx).toBeLessThan(h1Idx);
  });

  test('generates valid ISO 8601 UTC timestamp', async () => {
    const path = await writeTempFile(FRESH_SPEC);
    const result = await handler.execute({ path, approver: 'bj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.approved_at).toMatch(ISO_8601_UTC);

    const updated = await readFile(path);
    const tsMatch = updated.match(/approved_at: (\S+)/);
    expect(tsMatch).not.toBeNull();
    expect(tsMatch![1]).toMatch(ISO_8601_UTC);
    // Handler return matches file content
    expect(tsMatch![1]).toBe(parsed.approved_at);
  });

  test('returns the written metadata in the response', async () => {
    const path = await writeTempFile(FRESH_SPEC);
    const result = await handler.execute({
      path,
      approver: 'bj',
      finalization_score: '6/7',
    });
    const parsed = parseResult(result);
    expect(parsed).toEqual({
      ok: true,
      path,
      approved_at: parsed.approved_at, // shape match; format validated separately
      approved_by: 'bj',
      finalization_score: '6/7',
    });
    expect(parsed.approved_at).toMatch(ISO_8601_UTC);
  });

  test('uses default finalization_score of 7/7 when not supplied', async () => {
    const path = await writeTempFile(FRESH_SPEC);
    const result = await handler.execute({ path, approver: 'bj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.finalization_score).toBe('7/7');
    const updated = await readFile(path);
    expect(updated).toContain('finalization_score: 7/7');
  });

  test('missing file returns structured error', async () => {
    const result = await handler.execute({
      path: '/tmp/devspec-approve-nonexistent-xyz-12345.md',
      approver: 'bj',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
  });

  test('schema validation — rejects missing path', async () => {
    const result = await handler.execute({ approver: 'bj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema validation — rejects missing approver', async () => {
    const path = await writeTempFile(FRESH_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema validation — rejects empty path', async () => {
    const result = await handler.execute({ path: '', approver: 'bj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
