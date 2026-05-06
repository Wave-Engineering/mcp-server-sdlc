/**
 * Body-section splicing for `work_item_update` (#287).
 *
 * Replace a single `## H2` section in an issue body, preserving all other
 * sections verbatim — including any pre-H2 preamble, section ordering, and
 * trailing whitespace style. Heading match is normalized via
 * `normalizeHeading` from `lib/spec_parser.ts`, so `## Dependencies`,
 * `## dependencies`, and `##  Dependencies  ` all match the same canonical key.
 *
 * Lives in `lib/` so the handler registry codegen (which scans `handlers/*.ts`)
 * ignores it.
 */

import { normalizeHeading } from './spec_parser.js';

export type SpliceResult =
  | { ok: true; body: string }
  | { ok: false; error: string };

/**
 * Replace the content of a single H2 section in `body`.
 *
 * - `heading` is the canonical heading text (e.g. `Dependencies` or
 *   `## Dependencies`); leading `##` is stripped, then normalized.
 * - `content` is the new section body (without the H2 header line). It is
 *   inserted verbatim between the existing H2 line and the next H2 (or EOF).
 *
 * If the section is not found, returns `{ok: false, error}` so the caller can
 * surface a typed envelope error rather than silently appending a new section.
 *
 * The H2 header line is preserved exactly as it appeared in the input (so we
 * don't normalize `##  Dependencies` to `## Dependencies` on the way through).
 */
export function spliceH2Section(
  body: string,
  heading: string,
  content: string,
): SpliceResult {
  const targetKey = normalizeHeading(heading.replace(/^#+\s*/, ''));
  if (!targetKey) {
    return { ok: false, error: 'heading must be non-empty' };
  }

  const lines = body.split('\n');
  let startIdx = -1;
  let endIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (m && normalizeHeading(m[1]) === targetKey) {
      startIdx = i;
      // Walk forward to the next H2 (or EOF) — that's the section's end.
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s+/.test(lines[j])) {
          endIdx = j;
          break;
        }
      }
      break;
    }
  }

  if (startIdx === -1) {
    return {
      ok: false,
      error: `section "## ${heading}" not found in body`,
    };
  }

  // Build replacement: keep the H2 header line as-is, then a blank line, then
  // the new content, then a trailing blank line if the original section had
  // one. This preserves the most common formatting style without trying to be
  // clever about exact whitespace.
  const headerLine = lines[startIdx];
  const trimmedContent = content.replace(/\n+$/, '');
  const newSectionLines = ['', trimmedContent, ''];
  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);

  const merged = [...before, headerLine, ...newSectionLines, ...after];
  return { ok: true, body: merged.join('\n').replace(/\n{3,}/g, '\n\n') };
}
