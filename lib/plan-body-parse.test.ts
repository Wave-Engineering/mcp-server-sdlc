/**
 * Tests for `lib/plan-body-parse.ts` — Plan body parsing and DoD extraction.
 */

import { describe, test, expect } from 'bun:test';
import { parsePlanBody, validatePlanBodyStructure } from './plan-body-parse';

describe('parsePlanBody', () => {
  test('parses canonical Plan body (golden path)', () => {
    const body = `
## Plan-level Definition of Done

- [ ] All Phase deliverables complete
- [x] Test coverage ≥ 90%
- [ ] Documentation updated

## Phases

### Phase 1 — Foundation

Setup and scaffolding.

**DoD:**

- [ ] Database schema created [R-01]
- [ ] API endpoints stubbed [R-02]
- [x] README updated

### Phase 2 — Core Logic

Implement business logic.

**DoD:**

- [ ] Payment processing integrated [R-03]
- [ ] Validation rules applied

## References

Dev Spec: \`docs/specs/payment-system.md\`
Architecture: \`docs/arch/overview.md\`
`;

    const result = parsePlanBody(body);

    expect(result.plan_level_dod).toHaveLength(3);
    expect(result.plan_level_dod[0]).toEqual({
      checked: false,
      text: 'All Phase deliverables complete',
    });
    expect(result.plan_level_dod[1]).toEqual({
      checked: true,
      text: 'Test coverage ≥ 90%',
    });
    expect(result.plan_level_dod[2]).toEqual({
      checked: false,
      text: 'Documentation updated',
    });

    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].phase_name).toBe('Foundation');
    expect(result.phases[0].items).toHaveLength(3);
    expect(result.phases[0].items[0]).toEqual({
      checked: false,
      text: 'Database schema created',
      ref: 'R-01',
    });
    expect(result.phases[0].items[1]).toEqual({
      checked: false,
      text: 'API endpoints stubbed',
      ref: 'R-02',
    });
    expect(result.phases[0].items[2]).toEqual({
      checked: true,
      text: 'README updated',
    });

    expect(result.phases[1].phase_name).toBe('Core Logic');
    expect(result.phases[1].items).toHaveLength(2);
    expect(result.phases[1].items[0]).toEqual({
      checked: false,
      text: 'Payment processing integrated',
      ref: 'R-03',
    });

    expect(result.devspec_path).toBe('docs/specs/payment-system.md');
    expect(result.references).toHaveLength(2);
    expect(result.references[0]).toContain('Dev Spec:');
    expect(result.references[1]).toContain('Architecture:');
  });

  test('extracts Plan-level DoD checkboxes with checked state', () => {
    const body = `
## Plan-level Definition of Done

- [x] Item 1 checked
- [ ] Item 2 unchecked
- [X] Item 3 checked uppercase
`;

    const result = parsePlanBody(body);

    expect(result.plan_level_dod).toHaveLength(3);
    expect(result.plan_level_dod[0].checked).toBe(true);
    expect(result.plan_level_dod[0].text).toBe('Item 1 checked');
    expect(result.plan_level_dod[1].checked).toBe(false);
    expect(result.plan_level_dod[1].text).toBe('Item 2 unchecked');
    expect(result.plan_level_dod[2].checked).toBe(true);
    expect(result.plan_level_dod[2].text).toBe('Item 3 checked uppercase');
  });

  test('extracts per-Phase DoD with [R-XX] ref suffix', () => {
    const body = `
## Phases

### Phase 1 — Setup

**DoD:**

- [ ] Task A [R-01]
- [ ] Task B [R-10]
- [ ] Task C without ref
`;

    const result = parsePlanBody(body);

    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].items).toHaveLength(3);
    expect(result.phases[0].items[0].ref).toBe('R-01');
    expect(result.phases[0].items[0].text).toBe('Task A');
    expect(result.phases[0].items[1].ref).toBe('R-10');
    expect(result.phases[0].items[2].ref).toBeUndefined();
  });

  test('extracts Dev Spec path from References', () => {
    const body = `
## References

Dev Spec: \`path/to/spec.md\`
Other: \`other.md\`
`;

    const result = parsePlanBody(body);

    expect(result.devspec_path).toBe('path/to/spec.md');
    expect(result.references).toHaveLength(2);
  });

  test('handles Dev Spec without backticks', () => {
    const body = `
## References

Dev Spec: path/to/spec.md
`;

    const result = parsePlanBody(body);

    expect(result.devspec_path).toBe('path/to/spec.md');
  });

  test('returns empty arrays when sections missing', () => {
    const body = `
## Some Other Section

Content here.
`;

    const result = parsePlanBody(body);

    expect(result.plan_level_dod).toHaveLength(0);
    expect(result.phases).toHaveLength(0);
    expect(result.references).toHaveLength(0);
    expect(result.devspec_path).toBeUndefined();
  });

  test('handles Plan-level DoD alternative heading', () => {
    const body = `
## Plan-level DoD

- [ ] Item 1
`;

    const result = parsePlanBody(body);

    expect(result.plan_level_dod).toHaveLength(1);
    expect(result.plan_level_dod[0].text).toBe('Item 1');
  });

  test('handles multiple phases with varying DoD items', () => {
    const body = `
## Phases

### Phase 1 — Alpha

**DoD:**

- [ ] Alpha task 1

### Phase 2 — Beta

**DoD:**

- [ ] Beta task 1
- [ ] Beta task 2

### Phase 3 — Gamma

**DoD:**

- [x] Gamma task done
`;

    const result = parsePlanBody(body);

    expect(result.phases).toHaveLength(3);
    expect(result.phases[0].phase_name).toBe('Alpha');
    expect(result.phases[0].items).toHaveLength(1);
    expect(result.phases[1].phase_name).toBe('Beta');
    expect(result.phases[1].items).toHaveLength(2);
    expect(result.phases[2].phase_name).toBe('Gamma');
    expect(result.phases[2].items).toHaveLength(1);
    expect(result.phases[2].items[0].checked).toBe(true);
  });
});

describe('validatePlanBodyStructure', () => {
  test('returns empty array when all required headings present', () => {
    const body = `
## Plan-level Definition of Done

Content

## Phases

Content

## References

Content
`;

    const missing = validatePlanBodyStructure(body);
    expect(missing).toHaveLength(0);
  });

  test('returns missing heading names', () => {
    const body = `
## Plan-level Definition of Done

Content
`;

    const missing = validatePlanBodyStructure(body);
    expect(missing).toContain('phases');
    expect(missing).toContain('references');
    expect(missing).not.toContain('plan-level definition of done');
  });

  test('accepts "Plan-level DoD" variant', () => {
    const body = `
## Plan-level DoD

Content

## Phases

Content

## References

Content
`;

    const missing = validatePlanBodyStructure(body);
    expect(missing).toHaveLength(0);
  });

  test('detects all missing headings', () => {
    const body = `
## Some Other Section

Content
`;

    const missing = validatePlanBodyStructure(body);
    expect(missing).toHaveLength(3);
    expect(missing).toContain('plan-level definition of done');
    expect(missing).toContain('phases');
    expect(missing).toContain('references');
  });
});
