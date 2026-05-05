/**
 * Integration tests verifying that the three devspec parser bugs are fixed.
 *
 * These tests use the regression fixtures from lib/devspec-parser-fixtures.ts
 * and call the actual MCP handlers to ensure end-to-end behavior is correct.
 */
import { describe, test, expect } from 'bun:test';
import { TIER_2_FIXTURE, BOLD_MV_FIXTURE, WAVE_DEPS_FIXTURE } from '../lib/devspec-parser-fixtures.js';

const { default: devspecFinalizeHandler } = await import('../handlers/devspec_finalize.ts');
const { default: devspecSummaryHandler } = await import('../handlers/devspec_summary.ts');
const { default: devspecParseSection8Handler } = await import('../handlers/devspec_parse_section_8.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function writeTempSpec(content: string): Promise<string> {
  const path = `/tmp/devspec-bugs-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

describe('Bug 1: Tier 2 deliverables blindness', () => {
  test('devspec_summary counts both Tier 1 and Tier 2 deliverables', async () => {
    const path = await writeTempSpec(TIER_2_FIXTURE);
    const result = await devspecSummaryHandler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    // 9 Tier 1 (8 active + 1 N/A) + 1 Tier 2 = 10 total
    // Active count: 8 Tier 1 + 1 Tier 2 = 9 active
    expect(parsed.deliverables_active).toBe(9);
    expect(parsed.deliverables_na).toBe(1); // DM-08 is N/A
  });

  test('devspec_finalize recognizes Tier 2 rows for wave assignments', async () => {
    const path = await writeTempSpec(TIER_2_FIXTURE);
    const result = await devspecFinalizeHandler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);

    // Find the wave_assignments check
    const waveCheck = parsed.checks.find((c: { check: string }) => c.check === 'wave_assignments');
    expect(waveCheck).toBeDefined();
    expect(waveCheck.pass).toBe(true);
    // Evidence should mention 9 active rows (all have wave assignments)
    expect(waveCheck.evidence).toContain('9/9');
  });
});

describe('Bug 2: MV-XX boldness blindness', () => {
  test('devspec_finalize detects bold-wrapped MV-XX IDs', async () => {
    const path = await writeTempSpec(BOLD_MV_FIXTURE);
    const result = await devspecFinalizeHandler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);

    // Find the mv_coverage check
    const mvCheck = parsed.checks.find((c: { check: string }) => c.check === 'mv_coverage');
    expect(mvCheck).toBeDefined();
    expect(mvCheck.pass).toBe(true);
    // Evidence should mention 3 MV items
    expect(mvCheck.evidence).toContain('3 MV item');
  });

  test('devspec_finalize triggers Tier 2 requirement for bold MV items', async () => {
    const path = await writeTempSpec(BOLD_MV_FIXTURE);
    const result = await devspecFinalizeHandler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);

    // Find the tier2_triggers check
    const tier2Check = parsed.checks.find((c: { check: string }) => c.check === 'tier2_triggers');
    expect(tier2Check).toBeDefined();
    expect(tier2Check.pass).toBe(true);
    // The fixture has DM-10 Manual test procedures row, so trigger is satisfied
    expect(tier2Check.evidence).toContain('1/1');
  });
});

describe('Bug 3: Wave-grouping by wave|deps string', () => {
  test('devspec_parse_section_8 groups stories by wave number alone', async () => {
    const path = await writeTempSpec(WAVE_DEPS_FIXTURE);
    const result = await devspecParseSection8Handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.phases.length).toBe(1);

    const phase = parsed.phases[0];
    expect(phase.waves.length).toBe(3);

    // Wave 1: stories 1.1 and 1.2 (both have "Wave: 1")
    const wave1 = phase.waves.find((w: { number: string }) => w.number === '1');
    expect(wave1).toBeDefined();
    expect(wave1.stories.length).toBe(2);

    // Wave 2: stories 2.1 and 2.2 (both have "Wave: 2 | ..." but grouped by "2")
    const wave2 = phase.waves.find((w: { number: string }) => w.number === '2');
    expect(wave2).toBeDefined();
    expect(wave2.stories.length).toBe(2);

    // Wave 3: story 3.1 (has "Wave: 3 | ..." but grouped by "3")
    const wave3 = phase.waves.find((w: { number: string }) => w.number === '3');
    expect(wave3).toBeDefined();
    expect(wave3.stories.length).toBe(1);
  });

  test('devspec_parse_section_8 extracts per-story dependencies', async () => {
    const path = await writeTempSpec(WAVE_DEPS_FIXTURE);
    const result = await devspecParseSection8Handler.execute({ path });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);

    const phase = parsed.phases[0];
    const allStories = phase.waves.flatMap((w: { stories: unknown[] }) => w.stories);

    // Story 1.1 has "Dependencies: None"
    const story11 = allStories.find((s: { title: string }) => s.title.includes('Initialize project'));
    expect(story11).toBeDefined();
    expect(story11.dependencies).toEqual([]);

    // Story 1.2 has "Dependencies: None"
    const story12 = allStories.find((s: { title: string }) => s.title.includes('Set up CI'));
    expect(story12).toBeDefined();
    expect(story12.dependencies).toEqual([]);

    // Story 2.1 has "Dependencies: 1.1, 1.2"
    const story21 = allStories.find((s: { title: string }) => s.title.includes('Implement parser'));
    expect(story21).toBeDefined();
    expect(story21.dependencies).toEqual(['1.1', '1.2']);

    // Story 2.2 has "Dependencies: 1.1, 2.1"
    const story22 = allStories.find((s: { title: string }) => s.title.includes('Integrate parser'));
    expect(story22).toBeDefined();
    expect(story22.dependencies).toEqual(['1.1', '2.1']);

    // Story 3.1 has "Dependencies: 2.1, 2.2"
    const story31 = allStories.find((s: { title: string }) => s.title.includes('Add regression'));
    expect(story31).toBeDefined();
    expect(story31.dependencies).toEqual(['2.1', '2.2']);
  });
});
