/**
 * Pure parsers for the `epic_sub_issues` handler. Promoted out of
 * `handlers/epic_sub_issues.ts` during Story 2.6 (#300) so the handler can
 * shrink to a thin adapter-dispatch shell while the ~200 LoC of markdown
 * table / checklist-or-bullet / ref-normalization logic continues to live
 * behind its own colocated tests.
 *
 * Nothing here touches the platform, a subprocess, or the filesystem — these
 * functions are called with an already-extracted section string plus the
 * caller's repo slug. See `docs/issue-body-grammar.md` for the accepted
 * surface forms.
 */

export interface SubIssue {
  ref: string;
  title?: string;
  order?: number;
}

/**
 * Normalize a raw issue reference token into the canonical `org/repo#N`
 * shape (or bare `#N` when no repo slug context is available).
 *
 * Accepted input forms:
 *   - `https://github.com/<owner>/<repo>/issues/<N>` → `<owner>/<repo>#N`
 *   - `https://gitlab.com/<owner>/<repo>/-/issues/<N>` → `<owner>/<repo>#N`
 *   - `<owner>/<repo>#N` (already cross-repo qualified) → passthrough
 *   - `#N` or `N` (bare) → `<currentSlug>#N` when `currentSlug` is non-null,
 *     otherwise `#N`
 */
export function normalizeRef(ref: string, currentSlug: string | null): string {
  // URL
  const urlM =
    /https?:\/\/(?:github\.com|gitlab\.com)\/([^\s/]+)\/([^\s/]+)\/(?:-\/)?issues\/(\d+)/.exec(
      ref,
    );
  if (urlM) return `${urlM[1]}/${urlM[2]}#${urlM[3]}`;

  const crossM = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (crossM) return ref;

  const shortM = /^#?(\d+)$/.exec(ref);
  if (shortM) {
    return currentSlug ? `${currentSlug}#${shortM[1]}` : `#${shortM[1]}`;
  }
  return ref;
}

/**
 * Parse a markdown table with `Order | Issue | Title` columns (columns
 * matched case-insensitively by substring — `Issue Ref` / `Story Order` also
 * work). Returns `[]` when no `|`-delimited header row is present.
 */
export function parseTableRows(section: string, currentSlug: string | null): SubIssue[] {
  const lines = section.split('\n').map(l => l.trim());
  const subs: SubIssue[] = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('|') && lines[i].includes('|', 1)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];
  const headerCells = lines[headerIdx]
    .split('|')
    .slice(1, -1)
    .map(c => c.trim().toLowerCase());
  const colIdx = (name: string) => headerCells.findIndex(c => c.includes(name));
  const orderCol = colIdx('order');
  const issueCol = colIdx('issue');
  const titleCol = colIdx('title');

  let startRow = headerIdx + 1;
  if (startRow < lines.length && /^\|[\s\-:|]+\|$/.test(lines[startRow])) startRow += 1;

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const getCell = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : '');
    const issueRaw = getCell(issueCol);
    const refM = /#?(\d+)|([^/\s#]+)\/([^/\s#]+)#(\d+)/.exec(issueRaw);
    if (!refM) continue;
    const ref = normalizeRef(issueRaw, currentSlug);
    const order = orderCol >= 0 ? parseInt(getCell(orderCol), 10) : undefined;
    const title = titleCol >= 0 ? getCell(titleCol) : undefined;
    subs.push({
      ref,
      title: title && title.length > 0 ? title : undefined,
      order: Number.isFinite(order) ? (order as number) : undefined,
    });
  }
  return subs;
}

/**
 * Parse a checklist (`- [ ] #N Title`) or bullet list (`- #N Title`,
 * `- #N — Title`). `order` is the 1-based position of each matching bullet
 * (not a column value — the bullet form has no explicit order).
 */
export function parseChecklistOrBullets(
  section: string,
  currentSlug: string | null,
): SubIssue[] {
  const subs: SubIssue[] = [];
  const checklistRe = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  let position = 1;
  while ((m = checklistRe.exec(section)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    const refM =
      /(?:^|\s)([^/\s#]+\/[^/\s#]+#\d+|https?:\/\/\S+\/issues\/\d+|#\d+)/.exec(text);
    if (!refM) continue;
    const raw = refM[1];
    const ref = normalizeRef(raw, currentSlug);
    // Title = text with the ref token stripped out. Also strip leading
    // list/separator punctuation including em/en dashes commonly used in
    // `- #NN — Title` style bullets.
    const title = text.replace(refM[0], '').trim().replace(/^[-:*\s—–]+/, '').trim();
    subs.push({
      ref,
      title: title.length > 0 ? title : undefined,
      order: position,
    });
    position += 1;
  }
  return subs;
}
