/**
 * Platform-agnostic log truncation helper.
 *
 * Extracted from `handlers/ci_run_logs.ts` per Story 2.12 (#306) / R-17. Both
 * the GitHub and GitLab `ci_run_logs` adapters return RAW log text; the handler
 * applies this helper to keep the MCP response size bounded before the client
 * sees it.
 *
 * Strategy: split into lines, strip a single trailing empty line arising from
 * a trailing newline (common with both `gh run view --log` and `glab ci trace`
 * output), and — if the line count exceeds the effective max — keep a head-
 * and-tail slice with an "… N lines omitted …" marker in between. The head/
 * tail split is `floor(max/2)` head + `max - head` tail so odd limits favor
 * the tail (where error messages typically land).
 *
 * The hard cap (`HARD_MAX_LINES`) bounds the max regardless of caller
 * override — catches pathological `max_lines: 1_000_000` misuse from
 * untrusted callers.
 */

const HARD_MAX_LINES = 10000;

export const DEFAULT_MAX_LINES = 2000;

export interface TruncationResult {
  logs: string;
  line_count: number;
  truncated: boolean;
}

export function truncateLogs(rawLogs: string, requestedMax: number): TruncationResult {
  // Enforce hard cap regardless of caller override.
  const effectiveMax = Math.min(requestedMax, HARD_MAX_LINES);

  // Split preserving content. Strip a single trailing empty line from a
  // trailing newline so we don't count it as a "line".
  let lines = rawLogs.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  const originalCount = lines.length;

  if (originalCount <= effectiveMax) {
    return {
      logs: lines.join('\n'),
      line_count: originalCount,
      truncated: false,
    };
  }

  const halfHead = Math.floor(effectiveMax / 2);
  const halfTail = effectiveMax - halfHead;
  const head = lines.slice(0, halfHead);
  const tail = lines.slice(lines.length - halfTail);
  const omitted = originalCount - head.length - tail.length;
  const marker = `... [${omitted} lines omitted] ...`;

  const out = [...head, marker, ...tail].join('\n');
  // `line_count` reflects the ORIGINAL log size so callers can see how big
  // the real log was even after we've trimmed the payload.
  return {
    logs: out,
    line_count: originalCount,
    truncated: true,
  };
}
