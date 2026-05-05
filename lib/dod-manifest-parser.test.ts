import { describe, test, expect } from 'bun:test';
import {
  extractManifestSection,
  parseManifestTable,
  type Deliverable,
} from './dod-manifest-parser';

const SAMPLE_PRD = `# Some PRD

Intro text.

## Deliverables Manifest

| ID | Description | Evidence Path | Status | Category |
|----|-------------|---------------|--------|----------|
| D-01 | Wave init handler | handlers/wave_init.ts | done | code |
| D-02 | Docs updated | docs/WAVE.md | pending | docs |

## Next Section

Out of scope for manifest parsing.
`;

describe('dod-manifest-parser', () => {
  test('extractManifestSection — pulls Deliverables Manifest H2 block from a PRD body', () => {
    const section = extractManifestSection(SAMPLE_PRD);
    expect(section).not.toBeNull();
    expect(section).toContain('| D-01 | Wave init handler |');
    expect(section).toContain('| D-02 | Docs updated |');
    expect(section).not.toContain('Next Section');
    expect(section).not.toContain('Out of scope');
  });

  test('extractManifestSection — returns null when no Deliverables Manifest heading present', () => {
    const section = extractManifestSection('# PRD\n\nNo manifest here.\n');
    expect(section).toBeNull();
  });

  test('extractManifestSection — case-insensitive heading match', () => {
    const md = `## DELIVERABLES MANIFEST\n\nbody\n`;
    expect(extractManifestSection(md)).toBe('body');
  });

  test('extractManifestSection — handles H3+ nested content, stops at next H2', () => {
    const md = `## Deliverables Manifest

| ID | Description | Evidence Path | Status | Category |
|----|-------------|---------------|--------|----------|
| D-01 | desc | path | done | code |

### Sub-detail

more body

## Other
`;
    const section = extractManifestSection(md);
    expect(section).not.toBeNull();
    expect(section).toContain('Sub-detail');
    expect(section).toContain('more body');
    expect(section).not.toContain('Other');
  });

  test('parseManifestTable — well-formed table → typed rows', () => {
    const section = extractManifestSection(SAMPLE_PRD) ?? '';
    const { deliverables, warnings } = parseManifestTable(section);
    expect(warnings).toEqual([]);
    expect(deliverables.length).toBe(2);
    expect(deliverables[0]).toEqual({
      id: 'D-01',
      description: 'Wave init handler',
      evidence_path: 'handlers/wave_init.ts',
      status: 'done',
      category: 'code',
    } satisfies Deliverable);
    expect(deliverables[1].id).toBe('D-02');
  });

  test('parseManifestTable — no markdown table → warning, empty deliverables', () => {
    const { deliverables, warnings } = parseManifestTable('just prose, no pipes');
    expect(deliverables).toEqual([]);
    expect(warnings[0]).toContain('no markdown table');
  });

  test('parseManifestTable — malformed row (fewer cells) → warning, skipped', () => {
    const md = `| ID | Description | Evidence Path | Status | Category |
|----|-------------|---------------|--------|----------|
| D-01 | Only three cells |
| D-02 | Valid row | path/thing | done | code |`;
    const { deliverables, warnings } = parseManifestTable(md);
    expect(warnings.length).toBeGreaterThan(0);
    expect(deliverables.length).toBe(1);
    expect(deliverables[0].id).toBe('D-02');
  });

  test('parseManifestTable — flexible column order', () => {
    const md = `| Status | ID | Description | Evidence Path | Category |
|--------|----|-------------|---------------|----------|
| done | D-42 | flexible order | src/x.ts | code |`;
    const { deliverables } = parseManifestTable(md);
    expect(deliverables[0]).toEqual({
      id: 'D-42',
      description: 'flexible order',
      evidence_path: 'src/x.ts',
      status: 'done',
      category: 'code',
    });
  });

  test('extractManifestSection — H3 with section number prefix (### 5.A Deliverables Manifest)', () => {
    const md = `# Dev Spec

## 5. Deliverables & Definition of Done

### 5.A Deliverables Manifest

| ID | Description | Evidence Path | Status | Category |
|----|-------------|---------------|--------|----------|
| D-01 | Test deliverable | src/test.ts | pending | code |

### 5.B Test Plan

More content.
`;
    const section = extractManifestSection(md);
    expect(section).not.toBeNull();
    expect(section).toContain('| D-01 | Test deliverable |');
    expect(section).not.toContain('5.B Test Plan');
  });

  test('extractManifestSection — H2 without prefix (backward compatibility)', () => {
    const md = `# PRD

## Deliverables Manifest

| ID | Description | Evidence Path | Status | Category |
|----|-------------|---------------|--------|----------|
| D-01 | handler | handlers/x.ts | done | code |

## Other Section
`;
    const section = extractManifestSection(md);
    expect(section).not.toBeNull();
    expect(section).toContain('| D-01 | handler |');
    expect(section).not.toContain('Other Section');
  });
});
