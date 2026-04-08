import { describe, test, expect } from 'bun:test';

const { default: handler } = await import('../handlers/devspec_summary.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function writeTempFile(content: string): Promise<string> {
  const path = `/tmp/devspec-summary-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

// A complete Dev Spec fixture with all 9 sections, 5.A manifest with both
// active and N/A rows, Section 8 with multiple waves and stories.
const COMPLETE_SPEC = `# Sample Project — Development Specification

## 1. Problem Domain

Some background.

## 2. Constraints

Some constraints.

## 3. Requirements (EARS Format)

| ID | Type | Requirement |
|----|------|-------------|
| R-01 | Ubiquitous | The system shall foo. |

## 4. Concept of Operations

A flow.

## 5. Detailed Design

### 5.1 Some Design Topic

Detail.

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README | Docs | 1 | \`README.md\` | Wave 1 | required | Project overview |
| DM-02 | Build system | Code | 1 | \`Makefile\` | Wave 1 | required | Unified build |
| DM-03 | CI pipeline | Code | 1 | \`.github/workflows/ci.yml\` | Wave 1 | required | CI |
| DM-04 | Test suite | Test | 1 | \`tests/\` | Wave 2 | required | Unit + integration |
| DM-05 | Coverage report | Test | 1 | N/A — because this project has no runtime | Wave 1 | skipped | Lib only |
| DM-06 | CHANGELOG | Docs | 1 | N/A — because pre-1.0 | Wave 1 | skipped | Will add at 1.0 |

### 5.B Installation & Deployment

Install steps.

## 6. Test Plan

Test strategy.

## 7. Definition of Done

- [ ] All phases complete

## 8. Phased Implementation Plan

### Wave Map

\`\`\`
Wave 1 ─── [1.1] Foundation
              │
Wave 2 ─┬─ [2.1] Story A
         ├─ [2.2] Story B
         └─ [2.3] Story C
              │
Wave 3 ─── [3.1] Final story
\`\`\`

### Phase 1: Foundation (Epic)

#### Story 1.1: Project Scaffold

**Wave:** 1
**Repository:** acme/repo
**Dependencies:** None

Foundational scaffold.

**Acceptance Criteria:**

- [ ] Scaffold exists

#### Story 2.1: Feature A

**Wave:** 2

Feature A description.

#### Story 2.2: Feature B

**Wave:** 2

Feature B description.

#### Story 2.3: Feature C

**Wave:** 2

Feature C description.

#### Story 3.1: Final Polish

**Wave:** 3

Final polish.

## 9. Appendices

### Appendix A: Glossary

Terms.
`;

describe('devspec_summary handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('devspec_summary');
    expect(typeof handler.execute).toBe('function');
    expect(typeof handler.description).toBe('string');
  });

  test('counts all structural elements in a complete Dev Spec', async () => {
    const path = await writeTempFile(COMPLETE_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(path);
    expect(parsed.sections).toBe(9);
    // Stories 1.1, 2.1, 2.2, 2.3, 3.1 — five unique IDs.
    expect(parsed.stories).toBe(5);
    // Waves 1, 2, 3 (referenced via Wave Map and **Wave:** N annotations).
    expect(parsed.waves).toBe(3);
    // Active: DM-01, DM-02, DM-03, DM-04 = 4
    expect(parsed.deliverables_active).toBe(4);
    // N/A: DM-05, DM-06 = 2
    expect(parsed.deliverables_na).toBe(2);
  });

  test('handles missing Section 5.A — deliverables counts are 0', async () => {
    const md = `# Spec

## 1. Problem Domain

text

## 5. Detailed Design

No sub-section A here.

### 5.B Installation

text

## 8. Phased Implementation Plan

#### Story 1.1: Foo

**Wave:** 1

text
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.deliverables_active).toBe(0);
    expect(parsed.deliverables_na).toBe(0);
    expect(parsed.stories).toBe(1);
    expect(parsed.waves).toBe(1);
  });

  test('handles missing Section 8 — stories and waves are 0', async () => {
    const md = `# Spec

## 1. Problem Domain

text

## 5. Detailed Design

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README | Docs | 1 | \`README.md\` | Wave 1 | required | Overview |

### 5.B Installation

text

## 9. Appendices

text
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.stories).toBe(0);
    expect(parsed.waves).toBe(0);
    expect(parsed.deliverables_active).toBe(1);
    expect(parsed.deliverables_na).toBe(0);
  });

  test('distinguishes active vs N/A deliverables (mixed Notes-column rationale)', async () => {
    const md = `# Spec

## 5. Detailed Design

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | Real file | Docs | 1 | \`docs/foo.md\` | Wave 1 | required | ok |
| DM-02 | Skipped | Docs | 1 | N/A — because not applicable | Wave 1 | skipped | rationale in path col |
| DM-03 | Another real | Code | 1 | \`src/bar.ts\` | Wave 2 | required | ok |
| DM-04 | Skipped 2 | Test | 1 |  | Wave 1 | skipped | N/A — because rationale in notes |
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.deliverables_active).toBe(2);
    expect(parsed.deliverables_na).toBe(2);
  });

  test('counts nested story headings correctly (multiple phases, multiple stories per phase)', async () => {
    const md = `# Spec

## 8. Phased Implementation Plan

### Phase 1: Foundation

#### Story 1.1: A

text

#### Story 1.2: B

text

### Phase 2: Build

#### Story 2.1: C

text

#### Story 2.2: D

text

#### Story 2.3: E

text

### Phase 3: Polish

#### Story 3.1: F

text
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.stories).toBe(6);
  });

  test('returns ok:false when file is missing', async () => {
    const result = await handler.execute({
      path: '/tmp/devspec-summary-nonexistent-xyz-12345.md',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
  });

  test('schema validation rejects missing path', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema validation rejects empty path', async () => {
    const result = await handler.execute({ path: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('counts top-level sections only — sub-section ## numbering does not double-count', async () => {
    const md = `# Spec

## 1. Section One

### 1.1 Sub

### 1.2 Sub

## 2. Section Two

### 2.1 Sub

## 3. Section Three
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.sections).toBe(3);
  });
});
