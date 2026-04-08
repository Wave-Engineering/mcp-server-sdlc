import { describe, test, expect } from 'bun:test';

// This handler uses Bun.file() for local reads and does not shell out, so
// tests operate against real temp files in /tmp. No module mocks are needed
// (and per lesson_mcp_gotchas.md we avoid partial mock.module('fs') anyway).

const { default: handler } = await import('../handlers/devspec_finalize.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function writeTempSpec(content: string): Promise<string> {
  const path = `/tmp/devspec-finalize-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

function getCheck(parsed: { checks: Array<{ check: string; pass: boolean; evidence: string }> }, name: string) {
  const c = parsed.checks.find(x => x.check === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/**
 * A dev spec that should pass all 7 checks. Every Tier 1 row has a path or
 * N/A opt-out, the Manual Test Procedures Tier 2 row is present, all active
 * rows have Produced In, DM-09 has a path, no verb-only rows, Section 7
 * references the Deliverables Manifest.
 */
const HAPPY_SPEC = `# Project X — Development Specification

## 5. Detailed Design

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README.md | Docs | 1 | \`README.md\` | Wave 1 | required | overview |
| DM-02 | Unified build system | Code | 1 | \`Makefile\` | Wave 1 | required | |
| DM-03 | CI/CD pipeline | Code | 1 | \`.github/workflows/ci.yml\` | Wave 1 | required | |
| DM-04 | Automated test suite | Test | 1 | \`tests/\` | Wave 1 | required | |
| DM-05 | Test results (JUnit XML) | Test | 1 | \`reports/junit.xml\` | Wave 1 | required | |
| DM-06 | Coverage report | Test | 1 | \`reports/coverage.xml\` | Wave 1 | required | |
| DM-07 | CHANGELOG | Docs | 1 | \`CHANGELOG.md\` | Wave 1 | required | |
| DM-08 | VRTM | Trace | 1 | N/A — because the project is a spike | Wave 3 | required | |
| DM-09 | Audience-facing doc (runbook) | Docs | 1 | \`docs/runbook.md\` | Wave 2 | required | |
| DM-10 | Manual test procedures document | Docs | 2 | \`docs/manual-tests.md\` | Wave 3 | required | triggered by MV items |

## 6. Test Plan

### 6.4 Manual Verification Procedures

| ID | Procedure | Pass Criteria | Req IDs |
|----|-----------|--------------|---------|
| MV-01 | Click the button | Dialog appears | R-01 |
| MV-02 | Submit empty form | Error shows | R-02 |

## 7. Definition of Done

- [ ] All Phase DoD checklists satisfied
- [ ] All deliverables from the Deliverables Manifest (Section 5.A) produced and verified

### 7.2 Dev Spec Finalization Checklist

- [ ] Every Tier 1 row has a file path or N/A
`;

/**
 * Build a fresh HAPPY_SPEC variant with a surgical mutation applied. This
 * lets each negative test target a single check without bleed from other
 * fixture drift.
 */
function happyWith(mutator: (spec: string) => string): string {
  return mutator(HAPPY_SPEC);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('devspec_finalize handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('devspec_finalize');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy path — all 7 checks pass on a well-formed spec', async () => {
    const path = await writeTempSpec(HAPPY_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(path);
    expect(parsed.total).toBe(7);
    if (parsed.passed !== 7) {
      const failed = parsed.checks.filter((c: { pass: boolean }) => !c.pass);
      throw new Error(
        `expected all 7 checks to pass, got ${parsed.passed}/7. failed: ${JSON.stringify(failed)}`,
      );
    }
    expect(parsed.passed).toBe(7);
    expect(parsed.ready_for_approval).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBe(7);
    for (const c of parsed.checks) {
      expect(typeof c.check).toBe('string');
      expect(typeof c.pass).toBe('boolean');
      expect(typeof c.evidence).toBe('string');
      expect(c.evidence.length).toBeGreaterThan(0);
    }
  });

  test('tier1_paths fails when a Tier 1 row has no file path and no N/A', async () => {
    // Remove the file path from DM-07 (CHANGELOG).
    const spec = happyWith(s =>
      s.replace(
        '| DM-07 | CHANGELOG | Docs | 1 | `CHANGELOG.md` | Wave 1 | required | |',
        '| DM-07 | CHANGELOG | Docs | 1 | | Wave 1 | required | |',
      ),
    );
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'tier1_paths');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('DM-07');
    expect(parsed.ready_for_approval).toBe(false);
  });

  test('tier2_triggers fails when MV items exist but no Manual Test Procedures manifest row', async () => {
    const spec = happyWith(s =>
      s.replace(
        '| DM-10 | Manual test procedures document | Docs | 2 | `docs/manual-tests.md` | Wave 3 | required | triggered by MV items |\n',
        '',
      ),
    );
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'tier2_triggers');
    expect(check.pass).toBe(false);
    expect(check.evidence.toLowerCase()).toContain('manual');
  });

  test('wave_assignments fails when an active row is missing Produced In', async () => {
    // Clear Produced In for DM-02 (Makefile).
    const spec = happyWith(s =>
      s.replace(
        '| DM-02 | Unified build system | Code | 1 | `Makefile` | Wave 1 | required | |',
        '| DM-02 | Unified build system | Code | 1 | `Makefile` | | required | |',
      ),
    );
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'wave_assignments');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('DM-02');
  });

  test('mv_coverage fails when MV items exist but no manual-procedures row in manifest', async () => {
    // Same mutation as tier2_triggers, but asserting the mv_coverage check.
    const spec = happyWith(s =>
      s.replace(
        '| DM-10 | Manual test procedures document | Docs | 2 | `docs/manual-tests.md` | Wave 3 | required | triggered by MV items |\n',
        '',
      ),
    );
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'mv_coverage');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('MV-01');
  });

  test('verbs_without_nouns fails when a row is a bare verb phrase without a path', async () => {
    // Insert a verb-only row with no file path and no N/A.
    const spec = happyWith(s =>
      s.replace(
        '| DM-09 | Audience-facing doc (runbook) | Docs | 1 | `docs/runbook.md` | Wave 2 | required | |',
        '| DM-09 | Audience-facing doc (runbook) | Docs | 1 | `docs/runbook.md` | Wave 2 | required | |\n| DM-99 | Deploy it | Code | 3 | | Wave 2 | optional | |',
      ),
    );
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'verbs_without_nouns');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('DM-99');
  });

  test('audience_facing fails when DM-09 has no file path', async () => {
    const spec = happyWith(s =>
      s.replace(
        '| DM-09 | Audience-facing doc (runbook) | Docs | 1 | `docs/runbook.md` | Wave 2 | required | |',
        '| DM-09 | Audience-facing doc (runbook) | Docs | 1 | | Wave 2 | required | |',
      ),
    );
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'audience_facing');
    expect(check.pass).toBe(false);
    expect(check.evidence.toLowerCase()).toContain('audience');
  });

  test('dod_references fails when Section 7 has no mention of Deliverables Manifest', async () => {
    const spec = happyWith(s =>
      s.replace(
        '- [ ] All deliverables from the Deliverables Manifest (Section 5.A) produced and verified',
        '- [ ] All deliverables from the Artifact Manifest produced and verified',
      ),
    );
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'dod_references');
    expect(check.pass).toBe(false);
    expect(check.evidence.toLowerCase()).toContain('deliverables manifest');
  });

  test('missing Section 5.A → tier1_paths fails with descriptive evidence', async () => {
    const spec = `# Minimal Spec

## 6. Test Plan

### 6.4 Manual Verification Procedures

(none)

## 7. Definition of Done

- [ ] Everything is great per the Deliverables Manifest
`;
    const path = await writeTempSpec(spec);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    const t1 = getCheck(parsed, 'tier1_paths');
    expect(t1.pass).toBe(false);
    expect(t1.evidence.toLowerCase()).toContain('5.a');
    expect(parsed.ready_for_approval).toBe(false);
  });

  test('missing file → returns ok:false with file-not-found error', async () => {
    const result = await handler.execute({
      path: '/tmp/devspec-finalize-nonexistent-xyz-987654321.md',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
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

  test('return shape contract — includes all required fields', async () => {
    const path = await writeTempSpec(HAPPY_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed).toHaveProperty('ok', true);
    expect(parsed).toHaveProperty('path');
    expect(parsed).toHaveProperty('checks');
    expect(parsed).toHaveProperty('passed');
    expect(parsed).toHaveProperty('total', 7);
    expect(parsed).toHaveProperty('ready_for_approval');
    const names = parsed.checks.map((c: { check: string }) => c.check).sort();
    expect(names).toEqual(
      [
        'audience_facing',
        'dod_references',
        'mv_coverage',
        'tier1_paths',
        'tier2_triggers',
        'verbs_without_nouns',
        'wave_assignments',
      ].sort(),
    );
  });
});
