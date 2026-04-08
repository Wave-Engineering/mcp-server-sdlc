import { describe, test, expect } from 'bun:test';

const { default: handler } = await import('../handlers/devspec_parse_section_8.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function writeTempFile(content: string): Promise<string> {
  const path = `/tmp/devspec-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

const SINGLE_PHASE_SINGLE_STORY = `# My Dev Spec

## 7. Definition of Done

prior section.

## 8. Phased Implementation Plan

### How to read this section

Skip me.

### Phase 1: Foundation

**Goal:** Bootstrap the project.

#### Phase 1 Definition of Done

- [ ] Repo scaffold exists [R-01]
- [ ] CI pipeline green [R-02]

---

#### Story 1.1: Project Scaffold

**Wave:** 1
**Repository:** acme/widgets
**Dependencies:** None

Sets up the package layout.

**Implementation Steps:**

1. Create pyproject.toml
2. Create src/widgets/__init__.py
3. Add empty tests/ directory

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`test_import\` | smoke import works | \`tests/test_smoke.py\` |

*Integration/E2E Coverage:*

- IT-01 — now runnable
- E2E-01 — partially runnable (needs Story 2.1)

**Acceptance Criteria:**

- [ ] pyproject.toml exists [R-01]
- [ ] tests/test_smoke.py passes [R-02]

---

## 9. Appendices

irrelevant.
`;

const MULTI_PHASE_MULTI_WAVE = `# Spec

## 8. Phased Implementation Plan

### Phase 1: Foundation

#### Phase 1 Definition of Done

- [ ] Foundation done

#### Story 1.1: Scaffold

**Wave:** 1
**Repository:** acme/repo
**Dependencies:** None

**Implementation Steps:**

1. Step A

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`t1\` | p1 | \`f1\` |

*Integration/E2E Coverage:*

- IT-01

**Acceptance Criteria:**

- [ ] AC-1

---

### Phase 2: Features

#### Phase 2 Definition of Done

- [ ] All features land

#### Story 2.1: Feature A

**Wave:** 2
**Dependencies:** 1.1

**Implementation Steps:**

1. Build A

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`t_a\` | tests A | \`tests/a.ts\` |

*Integration/E2E Coverage:*

- IT-A

**Acceptance Criteria:**

- [ ] A works

---

#### Story 2.2: Feature B

**Wave:** 2
**Dependencies:** 1.1

**Implementation Steps:**

1. Build B

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`t_b\` | tests B | \`tests/b.ts\` |

*Integration/E2E Coverage:*

- IT-B

**Acceptance Criteria:**

- [ ] B works

---

#### Story 2.3: Feature C

**Wave:** 3
**Dependencies:** 2.1, 2.2

**Implementation Steps:**

1. Build C

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| \`t_c\` | tests C | \`tests/c.ts\` |

*Integration/E2E Coverage:*

- IT-C

**Acceptance Criteria:**

- [ ] C works

---
`;

const MISSING_WAVE_METADATA = `## 8. Phased Implementation Plan

### Phase 1: Foundation

#### Phase 1 Definition of Done

- [ ] Done

#### Story 1.1: Untagged Story

**Repository:** acme/repo
**Dependencies:** None

**Implementation Steps:**

1. Just do it

**Acceptance Criteria:**

- [ ] Built
`;

const NO_SECTION_8 = `# Spec

## 7. Definition of Done

Some content.

## 9. Appendices

End.
`;

const MALFORMED_STORY = `## 8. Phased Implementation Plan

### Phase 1: Foundation

#### Phase 1 Definition of Done

- [ ] Done

#### Story 1.1: Empty Story

**Wave:** 1

(no implementation steps, no acceptance criteria, no test procedures)

#### Story 1.2: Real Story

**Wave:** 1

**Implementation Steps:**

1. Build the thing

**Acceptance Criteria:**

- [ ] It works
`;

describe('devspec_parse_section_8 handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('devspec_parse_section_8');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses a single-phase single-story Dev Spec', async () => {
    const path = await writeTempFile(SINGLE_PHASE_SINGLE_STORY);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(path);
    expect(parsed.phases.length).toBe(1);

    const phase = parsed.phases[0];
    expect(phase.name).toBe('Phase 1: Foundation');
    expect(phase.dod_items.length).toBe(2);
    expect(phase.dod_items[0]).toBe('Repo scaffold exists [R-01]');

    expect(phase.waves.length).toBe(1);
    const wave = phase.waves[0];
    expect(wave.number).toBe('1');
    expect(wave.stories.length).toBe(1);

    const story = wave.stories[0];
    expect(story.title).toBe('Project Scaffold');
    expect(story.wave).toBe('1');
    expect(story.repo).toBe('acme/widgets');
    expect(story.dependencies).toEqual([]);
    expect(story.implementation_steps.length).toBe(3);
    expect(story.implementation_steps[0]).toBe('Create pyproject.toml');
    expect(story.acceptance_criteria.length).toBe(2);
    expect(story.acceptance_criteria[0]).toBe('pyproject.toml exists [R-01]');
  });

  test('extracts story metadata fields correctly', async () => {
    const path = await writeTempFile(SINGLE_PHASE_SINGLE_STORY);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const story = parsed.phases[0].waves[0].stories[0];

    expect(story.test_procedures.unit_tests.length).toBe(1);
    expect(story.test_procedures.unit_tests[0]).toEqual({
      name: 'test_import',
      purpose: 'smoke import works',
      file_location: 'tests/test_smoke.py',
    });

    expect(story.test_procedures.integration_coverage.length).toBe(2);
    expect(story.test_procedures.integration_coverage[0]).toBe('IT-01 — now runnable');
  });

  test('parses multi-phase multi-wave structure', async () => {
    const path = await writeTempFile(MULTI_PHASE_MULTI_WAVE);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.phases.length).toBe(2);

    const phase1 = parsed.phases[0];
    expect(phase1.name).toBe('Phase 1: Foundation');
    expect(phase1.waves.length).toBe(1);
    expect(phase1.waves[0].number).toBe('1');
    expect(phase1.waves[0].stories.length).toBe(1);
    expect(phase1.waves[0].stories[0].title).toBe('Scaffold');

    const phase2 = parsed.phases[1];
    expect(phase2.name).toBe('Phase 2: Features');
    expect(phase2.dod_items[0]).toBe('All features land');

    // Phase 2 has waves 2 and 3 (stories 2.1 + 2.2 in wave 2, story 2.3 in wave 3).
    expect(phase2.waves.length).toBe(2);
    expect(phase2.waves[0].number).toBe('2');
    expect(phase2.waves[0].stories.length).toBe(2);
    expect(phase2.waves[0].stories[0].title).toBe('Feature A');
    expect(phase2.waves[0].stories[1].title).toBe('Feature B');
    expect(phase2.waves[1].number).toBe('3');
    expect(phase2.waves[1].stories.length).toBe(1);
    expect(phase2.waves[1].stories[0].title).toBe('Feature C');
    expect(phase2.waves[1].stories[0].dependencies).toEqual(['2.1', '2.2']);
  });

  test('extracts Phase DoD checklists', async () => {
    const path = await writeTempFile(MULTI_PHASE_MULTI_WAVE);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.phases[0].dod_items).toEqual(['Foundation done']);
    expect(parsed.phases[1].dod_items).toEqual(['All features land']);
  });

  test('handles missing Wave metadata — defaults to "ungrouped"', async () => {
    const path = await writeTempFile(MISSING_WAVE_METADATA);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.phases.length).toBe(1);

    const wave = parsed.phases[0].waves[0];
    expect(wave.number).toBe('ungrouped');
    expect(wave.stories.length).toBe(1);
    expect(wave.stories[0].wave).toBe('ungrouped');
    expect(wave.stories[0].repo).toBe('acme/repo');
  });

  test('errors gracefully on missing Section 8', async () => {
    const path = await writeTempFile(NO_SECTION_8);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Section 8');
  });

  test('skips malformed story entries with a warning, continues parsing', async () => {
    const path = await writeTempFile(MALFORMED_STORY);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);

    const wave = parsed.phases[0].waves[0];
    expect(wave.stories.length).toBe(1);
    expect(wave.stories[0].title).toBe('Real Story');

    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings.some((w: string) => w.includes('Empty Story'))).toBe(true);
  });

  test('returns ok with empty phases when Section 8 has no real phases', async () => {
    const path = await writeTempFile(`## 8. Phased Implementation Plan\n\n### How to read this section\n\nNothing here yet.\n\n## 9. Appendices\n`);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.phases).toEqual([]);
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

  test('missing file returns structured error', async () => {
    const result = await handler.execute({ path: '/tmp/nonexistent-devspec-xyz-12345.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
  });
});
