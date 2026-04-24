import { describe, expect, test } from 'bun:test';
import {
  WaveStateSchema,
  WaveStateActionSchema,
  KahunaBranchHistoryEntrySchema,
  type WaveState,
} from '../lib/wave_state';

describe('WaveStateSchema — legacy state files (pre-KAHUNA)', () => {
  test('parses a minimal legacy state file without kahuna fields', () => {
    const legacy = {
      current_wave: null,
      current_action: { action: 'idle', label: 'idle', detail: '' },
      waves: {
        'wave-1a': { status: 'completed', mr_urls: { '1': 'https://example/pr/1' } },
      },
      issues: { '1': { status: 'closed' } },
      deferrals: [],
      last_updated: '2026-04-13T07:26:28Z',
      wavemachine_active: false,
    };
    const parsed = WaveStateSchema.parse(legacy);
    expect(parsed.kahuna_branch).toBeUndefined();
    expect(parsed.kahuna_branches).toBeUndefined();
    expect(parsed.current_wave).toBeNull();
    expect(parsed.waves?.['wave-1a']?.status).toBe('completed');
  });

  test('parses an empty object as a valid (empty) state', () => {
    const parsed = WaveStateSchema.parse({});
    expect(parsed).toEqual({});
  });

  test('preserves unknown top-level fields via passthrough', () => {
    const withExtra = { last_updated: '2026-04-24T00:00:00Z', future_field: { nested: true } };
    const parsed = WaveStateSchema.parse(withExtra) as WaveState & { future_field?: unknown };
    expect(parsed.future_field).toEqual({ nested: true });
  });
});

describe('WaveStateSchema — kahuna fields', () => {
  test('round-trips a state file populated with kahuna_branch + kahuna_branches history', () => {
    const populated = {
      current_wave: 'wave-1a',
      current_action: { action: 'gate_evaluating', label: 'gate_evaluating', detail: '4/4 signals' },
      kahuna_branch: 'kahuna/42-wave-status-cli',
      kahuna_branches: [
        {
          branch: 'kahuna/41-prior-epic',
          epic_id: 41,
          created_at: '2026-04-23T10:00:00Z',
          resolved_at: '2026-04-24T02:15:00Z',
          disposition: 'merged' as const,
          main_merge_sha: 'abc123def456',
        },
        {
          branch: 'kahuna/40-aborted-epic',
          epic_id: 40,
          created_at: '2026-04-22T08:00:00Z',
          resolved_at: '2026-04-22T09:30:00Z',
          disposition: 'aborted' as const,
          abort_reason: 'code_reviewer_critical_findings',
        },
      ],
      last_updated: '2026-04-24T02:16:00Z',
    };
    const parsed = WaveStateSchema.parse(populated);
    const roundTripped = WaveStateSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  test('accepts null kahuna_branch (epic closed, no current sandbox)', () => {
    const parsed = WaveStateSchema.parse({ kahuna_branch: null });
    expect(parsed.kahuna_branch).toBeNull();
  });

  test('accepts empty kahuna_branches array', () => {
    const parsed = WaveStateSchema.parse({ kahuna_branches: [] });
    expect(parsed.kahuna_branches).toEqual([]);
  });

  test('rejects kahuna_branches entry with an invalid disposition', () => {
    const bad = {
      kahuna_branches: [
        {
          branch: 'kahuna/1-foo',
          epic_id: 1,
          created_at: '2026-04-23T00:00:00Z',
          resolved_at: '2026-04-24T00:00:00Z',
          disposition: 'bogus',
        },
      ],
    };
    expect(() => WaveStateSchema.parse(bad)).toThrow();
  });

  test('rejects kahuna_branches entry missing required fields', () => {
    const bad = {
      kahuna_branches: [{ branch: 'kahuna/1-foo', epic_id: 1 }],
    };
    expect(() => WaveStateSchema.parse(bad)).toThrow();
  });
});

describe('KahunaBranchHistoryEntrySchema', () => {
  test('merged disposition with main_merge_sha is valid', () => {
    const entry = {
      branch: 'kahuna/1-foo',
      epic_id: 1,
      created_at: '2026-04-23T00:00:00Z',
      resolved_at: '2026-04-24T00:00:00Z',
      disposition: 'merged' as const,
      main_merge_sha: 'deadbeef',
    };
    expect(() => KahunaBranchHistoryEntrySchema.parse(entry)).not.toThrow();
  });

  test('aborted disposition with abort_reason is valid', () => {
    const entry = {
      branch: 'kahuna/2-bar',
      epic_id: 2,
      created_at: '2026-04-23T00:00:00Z',
      resolved_at: '2026-04-24T00:00:00Z',
      disposition: 'aborted' as const,
      abort_reason: 'ci_timeout',
    };
    expect(() => KahunaBranchHistoryEntrySchema.parse(entry)).not.toThrow();
  });

  test('merged disposition without main_merge_sha is accepted (permissive by design)', () => {
    const entry = {
      branch: 'kahuna/3-permissive-merged',
      epic_id: 3,
      created_at: '2026-04-23T00:00:00Z',
      resolved_at: '2026-04-24T00:00:00Z',
      disposition: 'merged' as const,
    };
    expect(() => KahunaBranchHistoryEntrySchema.parse(entry)).not.toThrow();
  });

  test('aborted disposition without abort_reason is accepted (permissive by design)', () => {
    const entry = {
      branch: 'kahuna/4-permissive-aborted',
      epic_id: 4,
      created_at: '2026-04-23T00:00:00Z',
      resolved_at: '2026-04-24T00:00:00Z',
      disposition: 'aborted' as const,
    };
    expect(() => KahunaBranchHistoryEntrySchema.parse(entry)).not.toThrow();
  });

  test('rejects non-positive epic_id', () => {
    const entry = {
      branch: 'kahuna/0-zero',
      epic_id: 0,
      created_at: '2026-04-23T00:00:00Z',
      resolved_at: '2026-04-24T00:00:00Z',
      disposition: 'merged' as const,
    };
    expect(() => KahunaBranchHistoryEntrySchema.parse(entry)).toThrow();
  });
});

describe('WaveStateActionSchema — gate_evaluating and gate_blocked', () => {
  test('accepts the new KAHUNA action values', () => {
    expect(() => WaveStateActionSchema.parse('gate_evaluating')).not.toThrow();
    expect(() => WaveStateActionSchema.parse('gate_blocked')).not.toThrow();
  });

  test('still accepts all pre-existing action values', () => {
    const existing = [
      'idle',
      'planning',
      'preflight',
      'in-flight',
      'flight-done',
      'review',
      'merging',
      'waiting',
      'waiting-ci',
      'complete',
    ];
    for (const v of existing) {
      expect(() => WaveStateActionSchema.parse(v)).not.toThrow();
    }
  });

  test('rejects unknown action values', () => {
    expect(() => WaveStateActionSchema.parse('bogus_action')).toThrow();
  });
});
