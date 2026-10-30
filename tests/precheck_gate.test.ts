import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';
// Bun's mock.module is process-global (#456): when a sibling file's shared fs
// mock is live, the adapters' writeFileSync records instead of writing, so a
// body file may never reach disk. `written()` reads whichever happened. This
// file does not install the mock itself: it would hide readFileSync from
// modules this file imports.
import { fsWriteCalls, resetFsMock } from '../lib/test-support/mock-fs.ts';
import { VALID_SQUASH_MESSAGE } from '../lib/test-support/precheck-stubs.ts';

// The precheck gate (#592): lib/precheck-gate.ts's policy, and the four
// handlers that apply it (pr_create, pr_ready, pr_merge, pr_merge_wait),
// exercised through the real adapters at the subprocess boundary on both
// platforms. The contract is claudecode-workflow's docs/precheck-status.md.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const gate = await import('../lib/precheck-gate.ts');
const { default: prCreate } = await import('../handlers/pr_create.ts');
const { default: prMerge } = await import('../handlers/pr_merge.ts');
const { default: prMergeWait } = await import('../handlers/pr_merge_wait.ts');
const { default: prReady } = await import('../handlers/pr_ready.ts');
const { clearMergeQueueCache } = await import('../lib/merge_queue_detect.ts');

const SHA = '1'.repeat(40);
const OTHER_SHA = '2'.repeat(40);

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

function call(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

/** What an adapter wrote to `path`: the shared fs mock's record if it was live, else the disk (Bun's own API). */
async function written(path: string): Promise<string> {
  const recorded = fsWriteCalls().find((w) => w.path === path);
  return recorded !== undefined ? String(recorded.data) : await Bun.file(path).text();
}

function fail(match: string, stderr = 'HTTP 500', status = 1): void {
  onExec(match, () => {
    const err = new Error(stderr) as ThrowableError;
    err.stderr = stderr;
    err.stdout = '';
    err.status = status;
    throw err;
  });
}

const COMMIT = gate.validateSquashMessage(VALID_SQUASH_MESSAGE);
if (!COMMIT.ok) throw new Error('VALID_SQUASH_MESSAGE must validate');
const BODY_WITH_BLOCK = gate.withSquashBlock('Implements it.', COMMIT.commit);

// --- platform fixtures -------------------------------------------------------

function github(): void {
  onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
}

function gitlab(): void {
  onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
}

interface PrFixture {
  head?: string;
  base?: string;
  body?: string;
  draft?: boolean;
  state?: string;
  sha?: string;
  title?: string;
  /** The head comes from a fork. */
  fork?: boolean;
}

function ghPr(f: PrFixture = {}): string {
  return JSON.stringify({
    id: 'PR_node',
    headRefOid: f.sha ?? SHA,
    headRefName: f.head ?? 'feature/592-x',
    baseRefName: f.base ?? 'main',
    title: f.title ?? 'feat(pr): x',
    body: f.body ?? BODY_WITH_BLOCK,
    isDraft: f.draft ?? false,
    state: f.state ?? 'OPEN',
    isCrossRepository: f.fork ?? false,
  });
}

function glMr(f: PrFixture = {}): string {
  return JSON.stringify({
    iid: 5,
    sha: f.sha ?? SHA,
    source_branch: f.head ?? 'feature/592-x',
    target_branch: f.base ?? 'main',
    title: f.title ?? 'feat(pr): x',
    description: f.body ?? BODY_WITH_BLOCK,
    draft: f.draft ?? false,
    state: f.state ?? 'opened',
    source_project_id: f.fork ? 99 : 10,
    target_project_id: 10,
    web_url: 'https://gitlab.com/org/repo/-/merge_requests/5',
  });
}

function ghStatus(state: string | null): void {
  onExec(
    '/status?per_page=100',
    JSON.stringify({ state: 'pending', statuses: state === null ? [] : [{ context: 'precheck', state }] }),
  );
}

function glStatus(status: string | null): void {
  onExec('/statuses?name=precheck', JSON.stringify(status === null ? [] : [{ id: 7, name: 'precheck', status }]));
}

beforeEach(() => {
  resetExecMock();
  resetFsMock();
  clearMergeQueueCache();
});

afterEach(() => {
  resetExecMock();
});

// =============================================================================
// Policy: the squash message, the block, the exemption
// =============================================================================

describe('validateSquashMessage', () => {
  const trailer = 'Co-Authored-By: Claude <noreply@anthropic.com>';
  const ok = (m: string) => gate.validateSquashMessage(m).ok;

  test('accepts a well-formed message, scoped or not, breaking or not', () => {
    expect(ok(VALID_SQUASH_MESSAGE)).toBe(true);
    expect(ok(`fix: x\n\nCloses #1\n\n${trailer}`)).toBe(true);
    expect(ok(`feat(api)!: x\n\nCloses Wave-Engineering/mcp-server-sdlc#592\n\n${trailer}`)).toBe(true);
  });

  test('rejects `docs` by name', () => {
    const r = gate.validateSquashMessage(`docs(readme): x\n\nCloses #1\n\n${trailer}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('`doc`, not `docs`');
  });

  test('rejects a bad type, a missing description and a long subject', () => {
    expect(ok(`feature: x\n\nCloses #1\n\n${trailer}`)).toBe(false);
    expect(ok(`feat:\n\nCloses #1\n\n${trailer}`)).toBe(false);
    expect(ok(`feat: ${'x'.repeat(70)}\n\nCloses #1\n\n${trailer}`)).toBe(false);
  });

  test('requires a blank line, then a body', () => {
    expect(ok(`feat: x\nCloses #1\n${trailer}`)).toBe(false);
    expect(ok('feat: x')).toBe(false);
  });

  test('requires Closes #N and the trailer', () => {
    expect(ok(`feat: x\n\nRefs #1\n\n${trailer}`)).toBe(false);
    expect(ok('feat: x\n\nCloses #1')).toBe(false);
  });
});

describe('the ## Squash commit block', () => {
  test('round-trips, including a message that carries its own fence', () => {
    const m = 'fix(x): y\n\nRun:\n\n```\nmake test\n```\n\nCloses #3\n\nCo-Authored-By: A <a@b.c>';
    const v = gate.validateSquashMessage(m);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const body = gate.withSquashBlock('Summary.', v.commit);
    const back = gate.parseSquashBlock(body);
    expect(back.ok).toBe(true);
    if (back.ok) expect(gate.formatSquashCommit(back.commit)).toBe(m);
  });

  test('withSquashBlock replaces an existing block rather than adding a second', () => {
    const once = gate.withSquashBlock('Summary.', COMMIT.commit);
    const twice = gate.withSquashBlock(once, COMMIT.commit);
    expect(twice.match(/^## Squash commit/gm)).toHaveLength(1);
  });

  test('withSquashBlock keeps the text after an existing block, and finds one in a CRLF body', () => {
    const body = `Summary.\n\n${gate.renderSquashBlock(COMMIT.commit)}\n\n## Test Plan\n\nRan it.`;
    const replaced = gate.withSquashBlock(body, COMMIT.commit);
    expect(replaced).toContain('## Test Plan\n\nRan it.');
    expect(gate.parseSquashBlock(replaced).ok).toBe(true);
    const crlf = gate.withSquashBlock(body.replace(/\n/g, '\r\n'), COMMIT.commit);
    expect(crlf.match(/^## Squash commit/gm)).toHaveLength(1);
    expect(gate.parseSquashBlock(crlf).ok).toBe(true);
  });

  test('no block, two blocks, an unclosed fence or an invalid message is no block', () => {
    expect(gate.parseSquashBlock('Just a body.').ok).toBe(false);
    expect(gate.parseSquashBlock(`${BODY_WITH_BLOCK}\n\n${gate.renderSquashBlock(COMMIT.commit)}`).ok).toBe(false);
    expect(gate.parseSquashBlock('## Squash commit\n\n```text\nfeat: x\n').ok).toBe(false);
    expect(gate.parseSquashBlock('## Squash commit\n\n```text\nnot a commit\n```').ok).toBe(false);
  });

  test('sameSquashMessage ignores line endings and outer whitespace only', () => {
    expect(gate.sameSquashMessage(`\n${VALID_SQUASH_MESSAGE.replace(/\n/g, '\r\n')}\n`, COMMIT.commit)).toBe(true);
    expect(gate.sameSquashMessage(VALID_SQUASH_MESSAGE.replace('said once', 'said twice'), COMMIT.commit)).toBe(false);
  });
});

describe('isIntegrationPair', () => {
  test('head kahuna/* or campaign/*, or base kahuna/*', () => {
    expect(gate.isIntegrationPair('kahuna/56-w1', 'main')).toBe(true);
    expect(gate.isIntegrationPair('campaign/56-x', 'main')).toBe(true);
    expect(gate.isIntegrationPair('feature/9-z', 'kahuna/56-w1')).toBe(true);
    expect(gate.isIntegrationPair('feature/9-z', 'main')).toBe(false);
    expect(gate.isIntegrationPair('feature/kahuna/x', 'main')).toBe(false);
    expect(gate.isIntegrationPair('feature/9-z', 'campaign/56-x')).toBe(false);
  });
});

// =============================================================================
// pr_create
// =============================================================================

describe('pr_create — the precheck gate', () => {
  const base = { title: 'feat(pr): x', body: 'Implements it.', base: 'main', head: 'feature/592-x' };

  function ghCreateStubs(): void {
    github();
    onExec('git branch --show-current', 'feature/592-x\n');
    onExec('/git/ref/heads/', JSON.stringify({ object: { sha: SHA } }));
    onExec('gh pr create', 'https://github.com/org/repo/pull/42\n');
    onExec(
      'gh pr view',
      JSON.stringify({ number: 42, url: 'https://github.com/org/repo/pull/42', state: 'OPEN', headRefName: 'feature/592-x', baseRefName: 'main' }),
    );
  }

  test('refuses without squash_message', async () => {
    ghCreateStubs();
    const r = parse(await prCreate.execute(base));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('squash_message_required');
    expect(call('gh pr create')).toBe('');
  });

  test('refuses an invalid squash_message, naming the rule', async () => {
    ghCreateStubs();
    const r = parse(await prCreate.execute({ ...base, squash_message: 'docs: x\n\nCloses #1\n\nCo-Authored-By: A <a@b.c>' }));
    expect(r.code).toBe('squash_message_invalid');
    expect(String(r.error)).toContain('`doc`');
  });

  test('refuses a body that already names the heading outside a block, rather than dropping text', async () => {
    ghCreateStubs();
    const body = 'Adds the gate.\n\n## Squash commit\n\nis the heading pr_create writes.\n\nCloses #592';
    const r = parse(await prCreate.execute({ ...base, body, squash_message: VALID_SQUASH_MESSAGE, draft: true }));
    expect(r.code).toBe('squash_block_ambiguous');
    expect(call('gh pr create')).toBe('');
  });

  test('a non-draft create refuses when the head has no precheck status', async () => {
    ghCreateStubs();
    ghStatus(null);
    const r = parse(await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('precheck_missing');
    expect(String(r.error)).toContain('/precheck');
    expect(call('gh pr create')).toBe('');
  });

  test('a non-draft create refuses a failed or pending status', async () => {
    for (const state of ['failure', 'error', 'pending']) {
      resetExecMock();
      ghCreateStubs();
      ghStatus(state);
      const r = parse(await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE }));
      expect(r.code).toBe('precheck_missing');
    }
  });

  test('reads the status on the head as the PLATFORM has it, not local HEAD', async () => {
    ghCreateStubs();
    ghStatus('success');
    const r = parse(await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.ok).toBe(true);
    expect(unquote(call('/git/ref/heads/'))).toContain('git/ref/heads/feature/592-x');
    expect(unquote(call('/status?per_page=100'))).toContain(`commits/${SHA}/status`);
  });

  test('an unreadable status or branch is no pass (fail closed)', async () => {
    ghCreateStubs();
    fail('/status?per_page=100');
    let r = parse(await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.code).toBe('precheck_unreadable');

    resetExecMock();
    github();
    onExec('git branch --show-current', 'feature/592-x\n');
    fail('/git/ref/heads/', 'HTTP 404: Not Found');
    r = parse(await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.code).toBe('precheck_unreadable');
    expect(call('gh pr create')).toBe('');
  });

  test('a draft skips the status check and still writes the block', async () => {
    ghCreateStubs();
    const r = parse(await prCreate.execute({ ...base, draft: true, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.ok).toBe(true);
    expect(call('/status?per_page=100')).toBe('');
    const create = unquote(call('gh pr create'));
    expect(create).toContain('--draft');
  });

  test('the body sent to the platform carries the ## Squash commit block', async () => {
    ghCreateStubs();
    ghStatus('success');
    await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE });
    const create = call('gh pr create');
    const file = /--body-file '([^']+)'/.exec(create)?.[1];
    const sent = file !== undefined ? await written(file) : unquote(create);
    expect(sent).toContain('## Squash commit');
    expect(sent).toContain('feat(pr): a deliberate squash commit');
  });

  test('an integration pair needs neither squash_message nor a status', async () => {
    github();
    onExec('gh pr create', 'https://github.com/org/repo/pull/43\n');
    onExec(
      'gh pr view',
      JSON.stringify({ number: 43, url: 'https://github.com/org/repo/pull/43', state: 'OPEN', headRefName: 'feature/9-z', baseRefName: 'kahuna/56-w1' }),
    );
    const r = parse(await prCreate.execute({ title: 't', body: 'b', base: 'kahuna/56-w1', head: 'feature/9-z' }));
    expect(r.ok).toBe(true);
    expect(call('/status?per_page=100')).toBe('');
  });

  test('gitlab: the same gate, with an error BODY on exit 0 read as no pass', async () => {
    gitlab();
    onExec('git branch --show-current', 'feature/592-x\n');
    onExec('/repository/branches/', JSON.stringify({ name: 'feature/592-x', commit: { id: SHA } }));
    // `glab api` exits 0 on an HTTP error and prints the body (#502).
    onExec('/statuses?name=precheck', JSON.stringify({ message: '403 Forbidden' }));
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/5\n');
    const r = parse(await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.code).toBe('precheck_unreadable');
    expect(call('glab mr create')).toBe('');
  });

  test('gitlab: a pass lets the create through', async () => {
    gitlab();
    onExec('git branch --show-current', 'feature/592-x\n');
    onExec('/repository/branches/', JSON.stringify({ name: 'feature/592-x', commit: { id: SHA } }));
    glStatus('success');
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/5\n');
    onExec(
      'merge_requests?source_branch',
      JSON.stringify([{ iid: 5, web_url: 'https://gitlab.com/org/repo/-/merge_requests/5', state: 'opened', source_branch: 'feature/592-x', target_branch: 'main' }]),
    );
    const r = parse(await prCreate.execute({ ...base, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.ok).toBe(true);
    expect(unquote(call('/repository/branches/'))).toContain('branches/feature%2F592-x');
  });
});

// =============================================================================
// pr_merge / pr_merge_wait
// =============================================================================

function ghMergeStubs(pr: PrFixture = {}): void {
  github();
  onExec('--json id,headRefOid', ghPr(pr));
  onExec('gh api graphql', JSON.stringify({ data: { repository: { mergeQueue: null } } }));
  onExec('gh pr merge 42', '');
  onExec(
    'gh pr view 42 --json state,url,mergeCommit',
    JSON.stringify({ state: 'MERGED', url: 'https://github.com/org/repo/pull/42', mergeCommit: { oid: 'abc123' } }),
  );
}

describe('pr_merge — the precheck gate', () => {
  test('the squash commit is exactly the block, and the merge is pinned to the checked head', async () => {
    ghMergeStubs();
    ghStatus('success');
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    const merge = call('gh pr merge 42');
    expect(merge).toContain(`--subject '${COMMIT.commit.subject}'`);
    expect(merge).toContain(`--match-head-commit '${SHA}'`);
    const file = /--body-file '([^']+)'/.exec(merge)?.[1];
    expect(file).toBeDefined();
    expect(await written(file as string)).toBe(COMMIT.commit.body);
  });

  test('refuses a PR whose body has no block', async () => {
    ghMergeStubs({ body: 'No block here.' });
    ghStatus('success');
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.code).toBe('squash_block_missing');
    expect(call('gh pr merge 42')).toBe('');
  });

  test('refuses merge_method merge and rebase', async () => {
    for (const merge_method of ['merge', 'rebase']) {
      resetExecMock();
      ghMergeStubs();
      ghStatus('success');
      const r = parse(await prMerge.execute({ number: 42, merge_method }));
      expect(r.code).toBe('merge_method_not_squash');
    }
    expect(call('gh pr merge 42')).toBe('');
  });

  test('a push after precheck blocks the merge: no pass on the new head', async () => {
    ghMergeStubs({ sha: OTHER_SHA });
    ghStatus(null);
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.code).toBe('precheck_missing');
    expect(unquote(call('/status?per_page=100'))).toContain(`commits/${OTHER_SHA}/status`);
    expect(call('gh pr merge 42')).toBe('');
  });

  test('a squash_message that differs from the block is refused; the same one is fine', async () => {
    ghMergeStubs();
    ghStatus('success');
    let r = parse(await prMerge.execute({ number: 42, squash_message: 'fix: something else' }));
    expect(r.code).toBe('squash_message_mismatch');
    resetExecMock();
    ghMergeStubs();
    ghStatus('success');
    r = parse(await prMerge.execute({ number: 42, squash_message: VALID_SQUASH_MESSAGE }));
    expect(r.ok).toBe(true);
  });

  test('an unreadable PR is no pass (fail closed)', async () => {
    github();
    fail('--json id,headRefOid', 'HTTP 502');
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.code).toBe('precheck_unreadable');
  });

  test('an integration pair passes through untouched, merge_method and all', async () => {
    ghMergeStubs({ head: 'kahuna/56-w1', body: '' });
    const r = parse(await prMerge.execute({ number: 42, merge_method: 'merge' }));
    expect(r.ok).toBe(true);
    const merge = call('gh pr merge 42');
    expect(merge).toContain('--merge');
    expect(merge).not.toContain('--subject');
    expect(merge).not.toContain('--match-head-commit');
    expect(call('/status?per_page=100')).toBe('');
  });

  test("a fork's kahuna/* head is a name, not an integration branch: gated", async () => {
    ghMergeStubs({ head: 'kahuna/56-w1', body: '', fork: true });
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.code).toBe('squash_block_missing');
    expect(call('gh pr merge 42')).toBe('');
  });

  test('gitlab: a fork is gated; a locked MR is gated; an unknown state is no pass', async () => {
    for (const [fixture, code] of [
      [{ head: 'kahuna/56-w1', body: '', fork: true }, 'squash_block_missing'],
      [{ state: 'locked', body: '' }, 'squash_block_missing'],
      [{ state: 'reopened' }, 'precheck_unreadable'],
    ] as Array<[PrFixture, string]>) {
      resetExecMock();
      gitlab();
      onExec('glab api projects/:id/merge_requests/5', glMr(fixture));
      const r = parse(await prMerge.execute({ number: 5 }));
      expect(r.code).toBe(code);
      expect(call('glab mr merge 5')).toBe('');
    }
  });

  test('gitlab: --squash-message is the whole block; the checked head is the --sha', async () => {
    gitlab();
    onExec('glab api projects/:id/merge_requests/5', glMr());
    glStatus('success');
    onExec('glab mr merge 5', '');
    let reads = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/5', () => {
      reads += 1;
      return glMr({ state: reads >= 2 ? 'merged' : 'opened' });
    });
    const r = parse(await prMerge.execute({ number: 5 }));
    expect(r.ok).toBe(true);
    const merge = call('glab mr merge 5');
    expect(merge).toContain(`--sha '${SHA}'`);
    expect(merge).toContain(`--squash-message '${VALID_SQUASH_MESSAGE}'`);
  });

  test('gitlab: a head that moved after the check refuses with head_moved, and nothing merges', async () => {
    // #609: the checked head is the merge --sha itself (no second head read), so
    // GitLab's stale-head guard is what catches the move: one attempt, pinned
    // to the checked head, refused, and never retried on the newer head.
    gitlab();
    onExec('glab api projects/:id/merge_requests/5', glMr({ sha: SHA }));
    glStatus('success');
    let attempts = 0;
    onExec('glab mr merge 5', () => {
      attempts += 1;
      const err = new Error('merge failed') as ThrowableError;
      err.stderr = '409 SHA does not match HEAD of source branch\n';
      throw err;
    });
    onExec('glab api projects/org%2Frepo/merge_requests/5', glMr({ sha: OTHER_SHA }));
    const r = parse(await prMerge.execute({ number: 5 }));
    expect(r.code).toBe('head_moved');
    expect(attempts).toBe(1);
    expect(call('glab mr merge 5')).toContain(`--sha '${SHA}'`);
    expect(call(`--sha '${OTHER_SHA}'`)).toBe('');
  });

  test('gitlab: a failed status refuses', async () => {
    gitlab();
    onExec('glab api projects/:id/merge_requests/5', glMr());
    glStatus('failed');
    const r = parse(await prMerge.execute({ number: 5 }));
    expect(r.code).toBe('precheck_missing');
  });
});

describe('pr_merge_wait — the same gate (no bypass around pr_merge)', () => {
  test('refuses a PR with no block, before any merge', async () => {
    ghMergeStubs({ body: 'No block.' });
    ghStatus('success');
    const r = parse(await prMergeWait.execute({ number: 42 }));
    expect(r.code).toBe('squash_block_missing');
    expect(call('gh pr merge 42')).toBe('');
  });

  test('refuses a head with no pass', async () => {
    ghMergeStubs();
    ghStatus(null);
    const r = parse(await prMergeWait.execute({ number: 42 }));
    expect(r.code).toBe('precheck_missing');
  });

  test('an already-merged PR is not gated (the wait short-circuits on it)', async () => {
    ghMergeStubs({ state: 'MERGED', body: '' });
    onExec('gh pr view 42', JSON.stringify({ state: 'MERGED', url: 'https://github.com/org/repo/pull/42', mergeCommit: { oid: 'abc123' } }));
    const r = parse(await prMergeWait.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    expect(call('/status?per_page=100')).toBe('');
  });
});

describe('pinned_head_sha — the pin echo (#611)', () => {
  test('a gated merge echoes the checked head', async () => {
    ghMergeStubs();
    ghStatus('success');
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    expect(r.pinned_head_sha).toBe(SHA);
  });

  test("an open integration pair echoes the caller's expected_head_sha", async () => {
    ghMergeStubs({ head: 'kahuna/56-w1', body: '' });
    const r = parse(await prMerge.execute({ number: 42, expected_head_sha: SHA }));
    expect(r.ok).toBe(true);
    expect(call('gh pr merge 42')).toContain(`--match-head-commit '${SHA}'`);
    expect(r.pinned_head_sha).toBe(SHA);
  });

  test('an integration pair without expected_head_sha echoes nothing', async () => {
    ghMergeStubs({ head: 'kahuna/56-w1', body: '' });
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    expect(r.pinned_head_sha).toBeUndefined();
  });

  test('an already-merged PR echoes nothing, though it reports merged', async () => {
    // It comes back merged:true with its old merge commit; an echo would let a
    // stale merge read as one pinned to the caller's head.
    ghMergeStubs({ state: 'MERGED', body: '' });
    const r = parse(await prMerge.execute({ number: 42, expected_head_sha: SHA }));
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(r.pinned_head_sha).toBeUndefined();
  });

  test('a failed merge is an error envelope with no echo', async () => {
    // Registered before ghMergeStubs: the first matching stub wins.
    fail('gh pr merge 42', 'GraphQL: Pull request is not mergeable (mergePullRequest)');
    onExec(
      'gh pr view 42 --json state,url,mergeCommit',
      JSON.stringify({ state: 'OPEN', url: 'https://github.com/org/repo/pull/42', mergeCommit: null }),
    );
    ghMergeStubs();
    ghStatus('success');
    const r = parse(await prMerge.execute({ number: 42 }));
    expect(r.ok).toBe(false);
    expect(r.pinned_head_sha).toBeUndefined();
  });

  test('gitlab: a gated merge echoes the checked head', async () => {
    gitlab();
    onExec('glab api projects/:id/merge_requests/5', glMr());
    glStatus('success');
    onExec('glab mr merge 5', '');
    let reads = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/5', () => {
      reads += 1;
      return glMr({ state: reads >= 2 ? 'merged' : 'opened' });
    });
    const r = parse(await prMerge.execute({ number: 5 }));
    expect(r.ok).toBe(true);
    expect(r.pinned_head_sha).toBe(SHA);
  });

  test('pr_merge_wait: a gated merge echoes the checked head', async () => {
    ghMergeStubs();
    ghStatus('success');
    const r = parse(await prMergeWait.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    expect(r.pinned_head_sha).toBe(SHA);
  });

  test('pr_merge_wait: an already-merged PR echoes nothing', async () => {
    ghMergeStubs({ state: 'MERGED', body: '' });
    onExec('gh pr view 42', JSON.stringify({ state: 'MERGED', url: 'https://github.com/org/repo/pull/42', mergeCommit: { oid: 'abc123' } }));
    const r = parse(await prMergeWait.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    expect(r.pinned_head_sha).toBeUndefined();
  });
});

// =============================================================================
// pr_ready
// =============================================================================

describe('pr_ready', () => {
  test('refuses without a pass, and writes nothing', async () => {
    github();
    onExec('--json id,headRefOid', ghPr({ draft: true }));
    ghStatus(null);
    const r = parse(await prReady.execute({ number: 42 }));
    expect(r.code).toBe('precheck_missing');
    expect(call('markPullRequestReadyForReview')).toBe('');
  });

  test('github: the GraphQL mutation, then a read-back', async () => {
    github();
    let views = 0;
    onExec('--json id,headRefOid', () => {
      views += 1;
      return ghPr({ draft: views < 3 });
    });
    ghStatus('success');
    onExec('markPullRequestReadyForReview', JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }));
    const r = parse(await prReady.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.draft).toBe(false);
    expect(unquote(call('markPullRequestReadyForReview'))).toContain('id=PR_node');
  });

  test('github: still a draft after the mutation is a failure, not a success', async () => {
    github();
    onExec('--json id,headRefOid', ghPr({ draft: true }));
    ghStatus('success');
    onExec('markPullRequestReadyForReview', JSON.stringify({ errors: [{ message: 'nope' }] }));
    const r = parse(await prReady.execute({ number: 42 }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('pr_ready_failed');
  });

  test('gitlab: strips every draft prefix from the title, then reads back', async () => {
    gitlab();
    onExec('-X PUT', glMr({ draft: false, title: 'feat(pr): x' }));
    let reads = 0;
    onExec('glab api projects/:id/merge_requests/5', () => {
      reads += 1;
      return glMr({ draft: reads < 3, title: reads < 3 ? 'Draft: [Draft] feat(pr): x' : 'feat(pr): x' });
    });
    glStatus('success');
    const r = parse(await prReady.execute({ number: 5 }));
    expect(r.ok).toBe(true);
    expect(unquote(call('-X PUT'))).toContain('title=feat(pr): x');
  });

  test('an integration pair needs no pass', async () => {
    github();
    let views = 0;
    onExec('--json id,headRefOid', () => {
      views += 1;
      return ghPr({ head: 'kahuna/56-w1', draft: views < 3 });
    });
    onExec('markPullRequestReadyForReview', '{}');
    const r = parse(await prReady.execute({ number: 42 }));
    expect(r.ok).toBe(true);
    expect(call('/status?per_page=100')).toBe('');
  });

  test('a closed PR is refused', async () => {
    github();
    onExec('--json id,headRefOid', ghPr({ state: 'CLOSED' }));
    const r = parse(await prReady.execute({ number: 42 }));
    expect(r.code).toBe('pr_not_open');
  });
});
