/**
 * The `precheck` gate (#592): the one place that decides whether a PR/MR may
 * be created ready, marked ready, or merged.
 *
 * claudecode-workflow#1235 made `/precheck` the MR gate. Agents commit and push
 * working branches freely, so the server, not skill prose, must hold the line
 * into a release branch (servers enforce, skills suggest). The contract is that
 * repo's docs/precheck-status.md. Three rules, applied by every handler that
 * can make a PR/MR mergeable or merge one (pr_create, pr_ready, pr_merge,
 * pr_merge_wait), so none of them is a way around the others:
 *
 *   1. A pass for THIS code: `precheck` = success on the exact head SHA.
 *   2. A deliberate squash commit: `squash_message`, validated, stored in the
 *      body as `## Squash commit`, and used verbatim at merge.
 *   3. Squash is the only merge method.
 *
 * Integration pairs are exempt from all three (head `kahuna/*` or `campaign/*`,
 * or base `kahuna/*`, with the head in the same repo): the wave trust gate
 * governs them, and no wave-engine caller supplies a squash message or block.
 *
 * Adapters supply the reads; this module holds the policy. Every read fails
 * closed: an `ok: false` read is "no pass", never "probably fine".
 */

import { runArgv } from './shared/error-norm.js';
import type { PlatformAdapter, PrPrecheckInfo } from './adapters/types.js';

export interface GateRefusal {
  code: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Rule 0: the exemption
// ---------------------------------------------------------------------------

const INTEGRATION_HEAD = /^(kahuna|campaign)\//;
const INTEGRATION_BASE = /^kahuna\//;

export function isIntegrationPair(head: string, base: string): boolean {
  return INTEGRATION_HEAD.test(head) || INTEGRATION_BASE.test(base);
}

/**
 * The exemption for an existing PR/MR. A fork's `kahuna/x` is a name, not an
 * integration branch: the wave trust gate never governs it, so it is gated.
 */
export function isExemptPr(info: PrPrecheckInfo): boolean {
  return info.same_repo && isIntegrationPair(info.head_ref, info.base_ref);
}

/** The checked-out branch, for a `pr_create` that omits `head`. Empty if detached. */
export function currentBranch(): string {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const r = runArgv(['git', 'branch', '--show-current'], cwd);
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

// ---------------------------------------------------------------------------
// Rule 2: the squash commit
// ---------------------------------------------------------------------------

export interface SquashCommit {
  subject: string;
  body: string;
}

const TYPES = 'feat|fix|doc|style|refactor|test|chore';
const SUBJECT = new RegExp(`^(${TYPES})(\\([^()\\s][^()]*\\))?!?: \\S`);
const CLOSES = /(^|\s)Closes\s+([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+)?#\d+\b/i;
const TRAILER = /^Co-Authored-By:\s+\S.*<[^<>\s]+@[^<>\s]+>\s*$/im;
const SUBJECT_MAX = 72;

function normalizeMessage(message: string): string {
  return message.replace(/\r\n/g, '\n').trim();
}

/** Validate a squash commit message; on success, split it into subject and body. */
export function validateSquashMessage(message: string): { ok: true; commit: SquashCommit } | { ok: false; error: string } {
  const text = normalizeMessage(message);
  const [subject = '', blank, ...rest] = text.split('\n');
  const body = rest.join('\n').trim();
  if (/^docs[(!:]/.test(subject)) {
    return { ok: false, error: 'squash_message: the commit type is `doc`, not `docs`' };
  }
  if (!SUBJECT.test(subject)) {
    return { ok: false, error: `squash_message: the subject must be \`type(scope): description\`, with type one of ${TYPES.replace(/\|/g, ', ')}; got ${JSON.stringify(subject)}` };
  }
  if (subject.length > SUBJECT_MAX) {
    return { ok: false, error: `squash_message: the subject is ${subject.length} characters; the limit is ${SUBJECT_MAX}` };
  }
  if (blank === undefined || blank.trim() !== '' || body === '') {
    return { ok: false, error: 'squash_message: a blank line, then a body, must follow the subject' };
  }
  if (!CLOSES.test(body)) {
    return { ok: false, error: 'squash_message: the body must say `Closes #N` (or `Closes owner/repo#N`)' };
  }
  if (!TRAILER.test(body)) {
    return { ok: false, error: 'squash_message: the body must end with a `Co-Authored-By: Name <email>` trailer' };
  }
  return { ok: true, commit: { subject, body } };
}

export function formatSquashCommit(c: SquashCommit): string {
  return `${c.subject}\n\n${c.body}`;
}

const HEADING = /^## Squash commit[ \t]*$/gm;

/** The `## Squash commit` block for a body. The fence outgrows any backtick run inside. */
export function renderSquashBlock(c: SquashCommit): string {
  const message = formatSquashCommit(c);
  const longest = Math.max(2, ...[...message.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `## Squash commit\n\n${fence}text\n${message}\n${fence}`;
}

interface BlockSpan {
  start: number;
  end: number;
  message: string;
}

/**
 * The block a heading opens, in LF-only `text`: from the heading to the end of
 * its closing fence. A string when the heading has no open, or no closed, fence.
 */
function locateBlock(text: string, heading: RegExpMatchArray): BlockSpan | string {
  const start = heading.index ?? 0;
  const afterAt = start + heading[0].length;
  const after = text.slice(afterAt);
  const open = /^\n*(`{3,})[^\n`]*\n/.exec(after);
  if (open === null) return 'the `## Squash commit` heading is not followed by a fenced block';
  const rest = after.slice(open[0].length);
  const close = new RegExp(`^${open[1]}\`*[ \\t]*$`, 'm').exec(rest);
  if (close === null) return 'the `## Squash commit` block is not closed';
  return { start, end: afterAt + open[0].length + close.index + close[0].length, message: rest.slice(0, close.index) };
}

/**
 * `body` with its squash block set to `c`: an existing block is replaced in
 * place, keeping the text around it; otherwise the block is appended. A body
 * that still doesn't parse back to `c` (it names the heading elsewhere) is the
 * caller's to refuse.
 */
export function withSquashBlock(body: string, c: SquashCommit): string {
  const text = body.replace(/\r\n/g, '\n');
  const spans = [...text.matchAll(HEADING)]
    .map((h) => locateBlock(text, h))
    .filter((s): s is BlockSpan => typeof s !== 'string');
  if (spans.length === 1) {
    return `${text.slice(0, spans[0].start)}${renderSquashBlock(c)}${text.slice(spans[0].end)}`;
  }
  return `${text.trimEnd()}\n\n${renderSquashBlock(c)}\n`;
}

/**
 * The squash commit a body carries: the fenced block under `## Squash commit`.
 * More than one heading, or a heading without a closed fence, is no block:
 * which commit lands must not be ambiguous.
 */
export function parseSquashBlock(body: string): { ok: true; commit: SquashCommit } | { ok: false; error: string } {
  const text = body.replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(HEADING)];
  if (headings.length === 0) return { ok: false, error: 'the PR/MR body has no `## Squash commit` block' };
  if (headings.length > 1) return { ok: false, error: 'the PR/MR body has more than one `## Squash commit` block' };
  const span = locateBlock(text, headings[0]);
  if (typeof span === 'string') return { ok: false, error: span };
  const v = validateSquashMessage(span.message);
  if (!v.ok) return { ok: false, error: `the \`## Squash commit\` block is invalid: ${v.error}` };
  return v;
}

/** True when `message` says exactly what the block says, up to line endings and outer whitespace. */
export function sameSquashMessage(message: string, c: SquashCommit): boolean {
  return normalizeMessage(message) === formatSquashCommit(c);
}

// ---------------------------------------------------------------------------
// Rule 1: the pass
// ---------------------------------------------------------------------------

const REMEDY = 'Run /precheck on this branch; it posts the `precheck` status on the head it reviewed.';

/** Undefined when `sha` carries `precheck` = success; otherwise the refusal. Fails closed. */
export async function requirePrecheckPass(
  adapter: PlatformAdapter,
  sha: string,
  repo: string | undefined,
  what: string,
): Promise<GateRefusal | undefined> {
  const r = await adapter.precheckStatus({ sha, repo });
  if ('platform_unsupported' in r) {
    return { code: 'precheck_unreadable', error: `${what}: the precheck status can't be read on this platform (${r.hint}). No pass, no ${what}.` };
  }
  if (!r.ok) {
    return { code: 'precheck_unreadable', error: `${what}: the precheck status of ${sha.slice(0, 7)} could not be read, which counts as no pass: ${r.error}` };
  }
  if (r.data.state === 'success') return undefined;
  const why = r.data.state === 'none' ? 'carries no `precheck` status' : `has \`precheck\` = ${r.data.state}`;
  return { code: 'precheck_missing', error: `${what}: head ${sha.slice(0, 7)} ${why}. ${REMEDY}` };
}

/** Where a branch points on the platform, or the refusal. Fails closed. */
export async function remoteHead(
  adapter: PlatformAdapter,
  branch: string,
  repo: string | undefined,
  what: string,
): Promise<{ ok: true; sha: string } | { ok: false; refusal: GateRefusal }> {
  const r = await adapter.remoteBranchSha({ branch, repo });
  if ('platform_unsupported' in r) {
    return { ok: false, refusal: { code: 'precheck_unreadable', error: `${what}: can't read where ${branch} points on this platform (${r.hint})` } };
  }
  if (!r.ok) {
    return { ok: false, refusal: { code: 'precheck_unreadable', error: `${what}: can't read where ${branch} points on the platform, which counts as no pass: ${r.error}` } };
  }
  return { ok: true, sha: r.data.sha };
}

/** One snapshot of a PR/MR for the gate, or the refusal. Fails closed. */
export async function prSnapshot(
  adapter: PlatformAdapter,
  number: number,
  repo: string | undefined,
  what: string,
): Promise<{ ok: true; info: PrPrecheckInfo } | { ok: false; refusal: GateRefusal }> {
  const r = await adapter.prPrecheckInfo({ number, repo });
  if ('platform_unsupported' in r) {
    return { ok: false, refusal: { code: 'precheck_unreadable', error: `${what}: can't read PR/MR #${number} on this platform (${r.hint})` } };
  }
  if (!r.ok) {
    return { ok: false, refusal: { code: 'precheck_unreadable', error: `${what}: can't read PR/MR #${number}, so its precheck can't be confirmed: ${r.error}` } };
  }
  return { ok: true, info: r.data };
}

// ---------------------------------------------------------------------------
// The merge decision, shared by pr_merge and pr_merge_wait
// ---------------------------------------------------------------------------

export interface MergeGateInput {
  number: number;
  repo?: string;
  merge_method?: 'squash' | 'merge' | 'rebase';
  squash_message?: string;
  /** The head the caller graded (#609). The gate's own head read stays authoritative. */
  expected_head_sha?: string;
}

/**
 * What the merge may proceed with. `pass` = not gated (an integration pair, or
 * a PR/MR that is no longer open, which the adapter reports on itself);
 * `gated` = the block's commit and the head SHA the pass was checked on.
 */
export type MergeGate =
  | { kind: 'pass' }
  | { kind: 'gated'; commit: SquashCommit; head_sha: string }
  | { kind: 'refused'; refusal: GateRefusal };

export async function mergeGate(adapter: PlatformAdapter, args: MergeGateInput, what: string): Promise<MergeGate> {
  const snap = await prSnapshot(adapter, args.number, args.repo, what);
  if (!snap.ok) return { kind: 'refused', refusal: snap.refusal };
  const info = snap.info;
  // Already merged or closed: nothing to gate. pr_merge_wait short-circuits on it.
  if (info.state !== 'open') return { kind: 'pass' };
  if (isExemptPr(info)) return { kind: 'pass' };
  // #609: the gate's head is the one the pass is checked on and the merge is
  // pinned to. A caller that graded a different head must not have it swapped
  // silently for this one, so a mismatch refuses before any merge is attempted.
  if (args.expected_head_sha !== undefined && args.expected_head_sha !== info.head_sha) {
    return {
      kind: 'refused',
      refusal: {
        code: 'head_moved',
        error:
          `${what}: PR/MR #${args.number}'s head is ${info.head_sha.slice(0, 7)}, not the ` +
          `expected_head_sha ${args.expected_head_sha.slice(0, 7)} the caller graded. Grade the current head, then merge again.`,
      },
    };
  }
  if ((args.merge_method ?? 'squash') !== 'squash') {
    return { kind: 'refused', refusal: { code: 'merge_method_not_squash', error: `${what}: only squash merges are allowed into ${info.base_ref || 'this base'}; got merge_method=${args.merge_method}` } };
  }
  const block = parseSquashBlock(info.body);
  if (!block.ok) {
    return { kind: 'refused', refusal: { code: 'squash_block_missing', error: `${what}: ${block.error}. pr_create writes it from squash_message; add one to the PR/MR body to merge.` } };
  }
  if (args.squash_message !== undefined && !sameSquashMessage(args.squash_message, block.commit)) {
    return { kind: 'refused', refusal: { code: 'squash_message_mismatch', error: `${what}: squash_message differs from the reviewed \`## Squash commit\` block. Omit squash_message, or edit the block in the PR/MR body.` } };
  }
  const refusal = await requirePrecheckPass(adapter, info.head_sha, args.repo, what);
  if (refusal !== undefined) return { kind: 'refused', refusal };
  return { kind: 'gated', commit: block.commit, head_sha: info.head_sha };
}
