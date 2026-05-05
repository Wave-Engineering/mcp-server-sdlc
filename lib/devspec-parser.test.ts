import { describe, test, expect } from 'bun:test';
import {
  extractSection,
  parseManifestTables,
  parseMvIds,
  parseWaveNumber,
  parseDependencies,
  hasPath,
  hasNAOptOut,
} from './devspec-parser.js';
import { TIER_2_FIXTURE, BOLD_MV_FIXTURE, WAVE_DEPS_FIXTURE } from './devspec-parser-fixtures.js';

describe('devspec-parser', () => {
  describe('extractSection', () => {
    test('extracts section by heading regex', () => {
      const md = `
# Doc

## 5. Design

### 5.A Deliverables

content here

## 6. Test
`;
      const section = extractSection(md, /^5\.\s+Design/);
      expect(section).toContain('5.A Deliverables');
      expect(section).not.toContain('## 6. Test');
    });
  });

  describe('parseManifestTables - Bug 1 fix', () => {
    test('parses multiple tables (Tier 1 and Tier 2)', () => {
      const sectionMd = `
Some intro text.

#### Tier 1

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README | Docs | 1 | \`README.md\` | Wave 1 | required | |
| DM-02 | CI pipeline | Code | 1 | \`.github/workflows/ci.yml\` | Wave 1 | required | |

#### Tier 2

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-10 | Manual tests | Docs | 2 | \`docs/manual-tests.md\` | Wave 3 | required | |
| DM-11 | Runbook | Docs | 2 | \`docs/runbook.md\` | Wave 3 | required | |
`;

      const rows = parseManifestTables(sectionMd);

      expect(rows.length).toBe(4);
      expect(rows[0].id).toBe('DM-01');
      expect(rows[0].tier).toBe('1');
      expect(rows[1].id).toBe('DM-02');
      expect(rows[1].tier).toBe('1');
      expect(rows[2].id).toBe('DM-10');
      expect(rows[2].tier).toBe('2');
      expect(rows[3].id).toBe('DM-11');
      expect(rows[3].tier).toBe('2');
    });

    test('parses Tier column when present', () => {
      const sectionMd = `
| ID | Deliverable | Tier | File Path |
|----|-------------|------|-----------|
| DM-01 | Item A | 1 | \`a.md\` |
| DM-02 | Item B | 2 | \`b.md\` |
`;
      const rows = parseManifestTables(sectionMd);
      expect(rows.length).toBe(2);
      expect(rows[0].tier).toBe('1');
      expect(rows[1].tier).toBe('2');
    });
  });

  describe('parseMvIds - Bug 2 fix', () => {
    test('parses plain MV-XX IDs', () => {
      const section64 = `
| ID | Procedure | Pass Criteria |
|----|-----------|---------------|
| MV-01 | Click button | Dialog opens |
| MV-02 | Submit form | Success message |
`;
      const ids = parseMvIds(section64);
      expect(ids).toEqual(['MV-01', 'MV-02']);
    });

    test('parses bold-wrapped MV-XX IDs', () => {
      const section64 = `
| ID | Procedure | Pass Criteria |
|----|-----------|---------------|
| **MV-01** | Click button | Dialog opens |
| **MV-02** | Submit form | Success message |
`;
      const ids = parseMvIds(section64);
      expect(ids).toEqual(['MV-01', 'MV-02']);
    });

    test('parses mixed plain and bold MV-XX IDs', () => {
      const section64 = `
| ID | Procedure |
|----|-----------|
| MV-01 | Plain |
| **MV-02** | Bold |
| MV-03 | Plain again |
`;
      const ids = parseMvIds(section64);
      expect(ids).toEqual(['MV-01', 'MV-02', 'MV-03']);
    });
  });

  describe('parseWaveNumber - Bug 3 fix', () => {
    test('extracts wave number without dependencies', () => {
      expect(parseWaveNumber('**Wave:** 2')).toBe('2');
      expect(parseWaveNumber('**Wave:** 3')).toBe('3');
    });

    test('strips dependencies after pipe', () => {
      expect(parseWaveNumber('**Wave:** 2 | 1.1, 1.2')).toBe('2');
      expect(parseWaveNumber('**Wave:** 3 | 2.1, 2.2, 2.3')).toBe('3');
    });

    test('returns null for non-Wave lines', () => {
      expect(parseWaveNumber('**Dependencies:** 1.1, 2.2')).toBeNull();
      expect(parseWaveNumber('Some other text')).toBeNull();
    });
  });

  describe('parseDependencies - Bug 3 fix', () => {
    test('parses comma-separated dependencies', () => {
      expect(parseDependencies('**Dependencies:** 1.1, 2.2, 3.3')).toEqual(['1.1', '2.2', '3.3']);
      expect(parseDependencies('**Dependencies:** 4.5')).toEqual(['4.5']);
    });

    test('handles "None" as empty array', () => {
      expect(parseDependencies('**Dependencies:** None')).toEqual([]);
      expect(parseDependencies('**Dependencies:** none')).toEqual([]);
    });

    test('returns null for non-Dependencies lines', () => {
      expect(parseDependencies('**Wave:** 2')).toBeNull();
      expect(parseDependencies('**Repository:** repo-name')).toBeNull();
    });
  });

  describe('hasPath', () => {
    test('returns true for non-empty file path', () => {
      const row = {
        id: 'DM-01',
        deliverable: 'README',
        category: 'Docs',
        tier: '1',
        file_path: '`README.md`',
        produced_in: 'Wave 1',
        status: 'required',
        notes: '',
        raw: {},
      };
      expect(hasPath(row)).toBe(true);
    });

    test('returns false for N/A path', () => {
      const row = {
        id: 'DM-02',
        deliverable: 'Item',
        category: 'Docs',
        tier: '1',
        file_path: 'N/A',
        produced_in: 'Wave 1',
        status: 'required',
        notes: '',
        raw: {},
      };
      expect(hasPath(row)).toBe(false);
    });
  });

  describe('hasNAOptOut', () => {
    test('detects N/A with em dash rationale', () => {
      const row = {
        id: 'DM-08',
        deliverable: 'VRTM',
        category: 'Trace',
        tier: '1',
        file_path: 'N/A — because the project is a spike',
        produced_in: 'Wave 3',
        status: 'required',
        notes: '',
        raw: {},
      };
      expect(hasNAOptOut(row)).toBe(true);
    });

    test('detects N/A with hyphen rationale', () => {
      const row = {
        id: 'DM-08',
        deliverable: 'VRTM',
        category: 'Trace',
        tier: '1',
        file_path: 'N/A - because the project is a spike',
        produced_in: 'Wave 3',
        status: 'required',
        notes: '',
        raw: {},
      };
      expect(hasNAOptOut(row)).toBe(true);
    });

    test('returns false for plain N/A without rationale', () => {
      const row = {
        id: 'DM-08',
        deliverable: 'Item',
        category: 'Docs',
        tier: '1',
        file_path: 'N/A',
        produced_in: 'Wave 3',
        status: 'required',
        notes: '',
        raw: {},
      };
      expect(hasNAOptOut(row)).toBe(false);
    });
  });

  describe('Regression fixtures', () => {
    test('TIER_2_FIXTURE - Bug 1: parses both Tier 1 and Tier 2 tables', () => {
      const section5A = extractSection(TIER_2_FIXTURE, /deliverables manifest/i);
      expect(section5A).not.toBeNull();

      const rows = parseManifestTables(section5A!);

      // Should have 9 Tier 1 rows + 1 Tier 2 row = 10 total
      expect(rows.length).toBe(10);

      const tier1 = rows.filter(r => r.tier === '1');
      const tier2 = rows.filter(r => r.tier === '2');

      expect(tier1.length).toBe(9);
      expect(tier2.length).toBe(1);
      expect(tier2[0].id).toBe('DM-10');
      expect(tier2[0].deliverable).toContain('Manual test procedures');
    });

    test('BOLD_MV_FIXTURE - Bug 2: parses bold-wrapped MV-XX IDs', () => {
      const section64 = extractSection(BOLD_MV_FIXTURE, /manual verification procedures/i);
      expect(section64).not.toBeNull();

      const mvIds = parseMvIds(section64!);

      expect(mvIds.length).toBe(3);
      expect(mvIds).toEqual(['MV-01', 'MV-02', 'MV-03']);
    });

    test('WAVE_DEPS_FIXTURE - Bug 3: strips dependencies from wave number', () => {
      // Story 1.1 has "Wave: 1" (no deps)
      const wave1Line = '**Wave:** 1';
      expect(parseWaveNumber(wave1Line)).toBe('1');

      // Story 2.1 has "Wave: 2 | 1.1, 1.2"
      const wave2Line = '**Wave:** 2 | 1.1, 1.2';
      expect(parseWaveNumber(wave2Line)).toBe('2');

      // Story 3.1 has "Wave: 3 | 2.1, 2.2"
      const wave3Line = '**Wave:** 3 | 2.1, 2.2';
      expect(parseWaveNumber(wave3Line)).toBe('3');
    });

    test('WAVE_DEPS_FIXTURE - Bug 3: parses separate Dependencies field', () => {
      // Story 1.1 has "Dependencies: None"
      expect(parseDependencies('**Dependencies:** None')).toEqual([]);

      // Story 2.1 has "Dependencies: 1.1, 1.2"
      expect(parseDependencies('**Dependencies:** 1.1, 1.2')).toEqual(['1.1', '1.2']);

      // Story 3.1 has "Dependencies: 2.1, 2.2"
      expect(parseDependencies('**Dependencies:** 2.1, 2.2')).toEqual(['2.1', '2.2']);
    });
  });
});
