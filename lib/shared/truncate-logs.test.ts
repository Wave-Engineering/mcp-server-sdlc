import { describe, test, expect } from 'bun:test';
import { truncateLogs, DEFAULT_MAX_LINES } from './truncate-logs.ts';

// Unit tests for the platform-agnostic truncation helper (Story 2.12, #306).
// Behavior preservation: these assertions mirror the `truncateLogs` block that
// previously lived in `handlers/ci_run_logs.ts` — the extraction is a pure
// refactor, not a semantic change.

describe('truncateLogs — truncates to configured limit, preserves tail', () => {
  test('short log — no truncation, no marker', () => {
    const r = truncateLogs('a\nb\nc\n', 100);
    expect(r.truncated).toBe(false);
    expect(r.line_count).toBe(3);
    expect(r.logs).toBe('a\nb\nc');
  });

  test('exact size match — no truncation', () => {
    const r = truncateLogs('a\nb\nc', 3);
    expect(r.truncated).toBe(false);
    expect(r.line_count).toBe(3);
  });

  test('empty input — zero lines, not truncated', () => {
    const r = truncateLogs('', 100);
    expect(r.truncated).toBe(false);
    expect(r.line_count).toBe(0);
    expect(r.logs).toBe('');
  });

  test('no trailing newline — line count matches content', () => {
    // Regression: a trailing newline used to inflate the count by one.
    const r = truncateLogs('a\nb\nc', 10);
    expect(r.line_count).toBe(3);
  });

  test('over max — head + tail with marker, preserves last lines', () => {
    const input = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    const r = truncateLogs(input, 6);
    expect(r.truncated).toBe(true);
    expect(r.line_count).toBe(20);
    const outLines = r.logs.split('\n');
    // 6/2 = 3 head + 3 tail + 1 marker line
    expect(outLines).toHaveLength(7);
    expect(outLines[0]).toBe('L0');
    expect(outLines[1]).toBe('L1');
    expect(outLines[2]).toBe('L2');
    expect(outLines[3]).toContain('14 lines omitted');
    expect(outLines[4]).toBe('L17');
    expect(outLines[5]).toBe('L18');
    expect(outLines[6]).toBe('L19');
  });

  test('odd max favors the tail slice (error messages cluster at end)', () => {
    const input = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n');
    const r = truncateLogs(input, 5);
    expect(r.truncated).toBe(true);
    const outLines = r.logs.split('\n');
    // floor(5/2)=2 head + 3 tail + marker
    expect(outLines).toHaveLength(6);
    expect(outLines.slice(0, 2)).toEqual(['L0', 'L1']);
    expect(outLines.slice(-3)).toEqual(['L7', 'L8', 'L9']);
  });

  test('hard cap — caller max above 10000 collapsed to 10000', () => {
    const input = Array.from({ length: 50000 }, (_, i) => `L${i}`).join('\n');
    const r = truncateLogs(input, 20000);
    expect(r.truncated).toBe(true);
    expect(r.line_count).toBe(50000);
    // 10000 lines kept + 1 marker
    expect(r.logs.split('\n')).toHaveLength(10001);
    expect(r.logs).toContain('lines omitted');
  });

  test('DEFAULT_MAX_LINES exported for handler reuse', () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
  });
});
