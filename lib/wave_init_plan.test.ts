import { describe, test, expect } from 'bun:test';
import { normalizePlanJson } from './wave_init_plan.ts';

describe('normalizePlanJson', () => {
  test('transforms devspec-upshift shape to wave-status shape', () => {
    const upshift = JSON.stringify({
      plan_id: 2,
      slug: 'org/repo',
      phases: [{
        name: 'Phase 1: Foundation',
        dod: ['deliverable'],
        waves: [{
          name: 'P1W1',
          stories: [
            { id: '1.1', issue: 501, title: 'Story A', depends_on: [] },
            { id: '1.2', issue: 502, title: 'Story B', depends_on: ['1.1'] },
          ],
        }],
      }],
    });

    const result = JSON.parse(normalizePlanJson(upshift));
    expect(result.project).toBe('org/repo');
    expect(result.phases[0].waves[0].id).toBe('P1W1');
    expect(result.phases[0].waves[0].stories).toBeUndefined();
    expect(result.phases[0].waves[0].name).toBeUndefined();
    expect(result.phases[0].waves[0].issues).toHaveLength(2);
    expect(result.phases[0].waves[0].issues[0]).toEqual({
      number: 501,
      repo: 'org/repo',
      ref: 'org/repo#501',
      title: 'Story A',
      depends_on: [],
    });
  });

  test('passes through already-correct wave-status shape', () => {
    const correct = JSON.stringify({
      project: 'org/repo',
      phases: [{
        waves: [{
          id: 'P1W1',
          issues: [{ number: 501, repo: 'org/repo', ref: 'org/repo#501' }],
        }],
      }],
    });

    expect(normalizePlanJson(correct)).toBe(correct);
  });

  test('uses repoSlug param when plan has no slug/project', () => {
    const upshift = JSON.stringify({
      plan_id: 2,
      phases: [{
        waves: [{
          name: 'P1W1',
          stories: [{ id: '1.1', issue: 10, title: 'Story', depends_on: [] }],
        }],
      }],
    });

    const result = JSON.parse(normalizePlanJson(upshift, 'team/project'));
    expect(result.project).toBe('team/project');
    expect(result.phases[0].waves[0].issues[0].repo).toBe('team/project');
    expect(result.phases[0].waves[0].issues[0].ref).toBe('team/project#10');
  });

  test('preserves multi-phase structure', () => {
    const upshift = JSON.stringify({
      plan_id: 5,
      slug: 'org/repo',
      phases: [
        { name: 'Phase 1', waves: [{ name: 'P1W1', stories: [{ id: '1.1', issue: 1, title: 'A', depends_on: [] }] }] },
        { name: 'Phase 2', waves: [{ name: 'P2W1', stories: [{ id: '2.1', issue: 2, title: 'B', depends_on: [] }] }] },
      ],
    });

    const result = JSON.parse(normalizePlanJson(upshift));
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].waves[0].id).toBe('P1W1');
    expect(result.phases[1].waves[0].id).toBe('P2W1');
  });

  test('returns original on invalid JSON', () => {
    expect(normalizePlanJson('not-json')).toBe('not-json');
  });

  test('returns original when phases is empty', () => {
    const empty = JSON.stringify({ phases: [] });
    expect(normalizePlanJson(empty)).toBe(empty);
  });

  test('cross-repo stories preserve their own repo field', () => {
    const upshift = JSON.stringify({
      plan_id: 2,
      slug: 'org/main-repo',
      phases: [{
        waves: [{
          name: 'P1W1',
          stories: [
            { id: '1.1', issue: 10, title: 'local', depends_on: [], repo: 'org/main-repo' },
            { id: '1.2', issue: 19, title: 'cross', depends_on: [], repo: 'org/other-repo' },
          ],
        }],
      }],
    });

    const result = JSON.parse(normalizePlanJson(upshift));
    expect(result.phases[0].waves[0].issues[1].repo).toBe('org/other-repo');
    expect(result.phases[0].waves[0].issues[1].ref).toBe('org/other-repo#19');
  });
});
