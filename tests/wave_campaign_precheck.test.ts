import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../lib/test-support/mock-child-process.ts';

// Mock only execSync so the test intercepts the read-only git probes
// (`git branch --list`, `git ls-remote`, `git merge-base --is-ancestor`)
// without disturbing fs — state/plan fixtures are written to a real /tmp dir.
installChildProcessMock();

const { default: handler } = await import('../handlers/wave_campaign_precheck.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function freshDir(tag: string): string {
  return `/tmp/wave-precheck-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function writeStatus(dir: string, plan: object | null, state: object | null) {
  const statusDir = `${dir}/.claude/status`;
  if (plan !== null) await Bun.write(`${statusDir}/phases-waves.json`, JSON.stringify(plan));
  if (state !== null) await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
}

/**
 * Build a git execSync responder from a declarative spec:
 *   locals: local branch names returned by `git branch --list`
 *   remotes: [{name, sha}] returned by `git ls-remote --heads`
 *   merged: predicate(refSubstr) → true means merge-base exits 0 (merged)
 */
function gitMock(opts: {
  locals?: string[];
  remotes?: Array<{ name: string; sha: string }>;
  merged?: (cmd: string) => boolean;
}) {
  // runArgv shell-escapes every token, so the cmd string looks like
  // `'git' 'branch' '--list' 'kahuna/*'`. Match on distinctive single tokens
  // that survive per-token quoting, not multi-word substrings.
  return (cmd: string) => {
    if (cmd.includes('--list')) {
      return (opts.locals ?? []).map(n => `  ${n}`).join('\n') + (opts.locals?.length ? '\n' : '');
    }
    if (cmd.includes('ls-remote')) {
      return (opts.remotes ?? []).map(r => `${r.sha}\trefs/heads/${r.name}`).join('\n');
    }
    if (cmd.includes('--is-ancestor')) {
      if (opts.merged && opts.merged(cmd)) return ''; // exit 0 → merged
      throw new Error('not an ancestor'); // non-zero → not merged
    }
    return '';
  };
}

function resetMocks() {
  resetExecMock();
  setExecMock(() => '');
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
}

describe('wave_campaign_precheck handler', () => {
  beforeEach(resetMocks);
  afterEach(restoreEnv);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_campaign_precheck');
    expect(typeof handler.execute).toBe('function');
  });

  test('clean_project — no plan state + no kahuna branch → state:clean', async () => {
    process.env.CLAUDE_PROJECT_DIR = freshDir('clean'); // dir never created → no status files
    setExecMock(gitMock({ locals: [], remotes: [] }));
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.ok).toBe(true);
    expect(parsed.state).toBe('clean');
    expect(parsed.classification).toBeUndefined();
  });

  test('dead_residue — all-promoted plan + kahuna merged → residue_found/dead, recommend replace', async () => {
    const dir = freshDir('dead');
    await writeStatus(
      dir,
      { phases: [{ waves: [{ id: 'w1' }] }] },
      { waves: { w1: { status: 'completed' } }, kahuna_branch: 'kahuna/77-foo' },
    );
    process.env.CLAUDE_PROJECT_DIR = dir;
    setExecMock(gitMock({ locals: ['kahuna/77-foo'], merged: () => true }));
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.ok).toBe(true);
    expect(parsed.state).toBe('residue_found');
    expect(parsed.classification).toBe('dead');
    expect(parsed.recommended).toBe('replace');
    expect(parsed.options).toEqual(['preserve_wait', 'preserve_extend', 'replace']);
    expect(parsed.residue.plan_id).toBe(77);
    expect(parsed.residue.pending_waves).toEqual([]);
    expect(parsed.residue.promoted_waves).toEqual(['w1']);
    expect(parsed.residue.kahuna_branches).toEqual([
      { name: 'kahuna/77-foo', local: true, remote: false, merged_into_protected: true },
    ]);
  });

  test('ambiguous_pending_waves — a pending wave forces ambiguous', async () => {
    const dir = freshDir('pending');
    await writeStatus(
      dir,
      { phases: [{ waves: [{ id: 'w1' }, { id: 'w2' }] }] },
      { waves: { w1: { status: 'completed' }, w2: { status: 'pending' } } },
    );
    process.env.CLAUDE_PROJECT_DIR = dir;
    setExecMock(gitMock({ locals: [], remotes: [] })); // no kahuna; isolate the pending trigger
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.state).toBe('residue_found');
    expect(parsed.classification).toBe('ambiguous');
    expect(parsed.residue.pending_waves).toEqual(['w2']);
    expect(parsed.residue.promoted_waves).toEqual(['w1']);
  });

  test('ambiguous_unmerged_kahuna — kahuna with commits not in protected → ambiguous', async () => {
    const dir = freshDir('unmerged');
    await writeStatus(
      dir,
      { phases: [{ waves: [{ id: 'w1' }] }] },
      { waves: { w1: { status: 'completed' } }, kahuna_branch: 'kahuna/77-foo' },
    );
    process.env.CLAUDE_PROJECT_DIR = dir;
    setExecMock(gitMock({ locals: ['kahuna/77-foo'], merged: () => false })); // not merged
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.classification).toBe('ambiguous');
    expect(parsed.residue.kahuna_branches[0].merged_into_protected).toBe(false);
  });

  test('ambiguous_active_flag — wavemachine_active:true → ambiguous even when otherwise dead', async () => {
    const dir = freshDir('active');
    await writeStatus(
      dir,
      { phases: [{ waves: [{ id: 'w1' }] }] },
      { waves: { w1: { status: 'completed' } }, wavemachine_active: true },
    );
    process.env.CLAUDE_PROJECT_DIR = dir;
    setExecMock(gitMock({ locals: [], remotes: [] }));
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.classification).toBe('ambiguous');
    expect(parsed.residue.wavemachine_active).toBe(true);
  });

  test('kahuna_local_and_remote — probes a local branch by NAME and a remote-only branch by its ls-remote SHA', async () => {
    const dir = freshDir('branches');
    await writeStatus(dir, { phases: [{ waves: [{ id: 'w1' }] }] }, { waves: { w1: { status: 'completed' } } });
    process.env.CLAUDE_PROJECT_DIR = dir;
    setExecMock(
      gitMock({
        locals: ['kahuna/77-foo'],
        remotes: [
          { name: 'kahuna/77-foo', sha: 'cafe77' },
          { name: 'kahuna/88-bar', sha: 'beef88' },
        ],
        // Discriminating predicate — merged iff the ancestry probe ran against the
        // local branch's NAME (kahuna/77-foo) OR the remote-only branch's SHA
        // (beef88). A bug that probed 77-foo by its remote SHA (cafe77), or 88-bar
        // by its NAME, matches neither token → not-merged → this test fails. So a
        // green here proves the ref selection at handler:124, not merely the flag.
        merged: (cmd: string) => cmd.includes('kahuna/77-foo') || cmd.includes('beef88'),
      }),
    );
    const parsed = parseResult(await handler.execute({}));
    const byName = Object.fromEntries(
      parsed.residue.kahuna_branches.map((b: { name: string }) => [b.name, b]),
    );
    // local branch → probed by NAME → merged (would be false if probed by cafe77)
    expect(byName['kahuna/77-foo']).toEqual({
      name: 'kahuna/77-foo',
      local: true,
      remote: true,
      merged_into_protected: true,
    });
    // remote-only branch → probed by its ls-remote SHA → merged (false if by name)
    expect(byName['kahuna/88-bar']).toEqual({
      name: 'kahuna/88-bar',
      local: false,
      remote: true,
      merged_into_protected: true,
    });
  });

  test('state_ghost_kahuna — a kahuna branch in state but absent from git → not-merged, ambiguous', async () => {
    const dir = freshDir('ghost');
    // Waves all promoted and wavemachine idle, so classification hinges purely on
    // the ghost: state references kahuna/99-ghost, but git carries neither a local
    // nor a remote copy (the state-only fold at handler:116, ref fallback at :124).
    // A real ghost ref makes `git merge-base --is-ancestor` error → not-merged; the
    // mock's default (no `merged` predicate → throw) models exactly that.
    await writeStatus(
      dir,
      { phases: [{ waves: [{ id: 'w1' }] }] },
      { waves: { w1: { status: 'completed' } }, kahuna_branch: 'kahuna/99-ghost' },
    );
    process.env.CLAUDE_PROJECT_DIR = dir;
    setExecMock(gitMock({ locals: [], remotes: [] }));
    const parsed = parseResult(await handler.execute({}));
    const ghost = parsed.residue.kahuna_branches.find(
      (b: { name: string }) => b.name === 'kahuna/99-ghost',
    );
    expect(ghost).toEqual({
      name: 'kahuna/99-ghost',
      local: false,
      remote: false,
      merged_into_protected: false,
    });
    expect(parsed.classification).toBe('ambiguous');
  });

  test('root_scoping — reads the root target repo, not the session project', async () => {
    const target = freshDir('target');
    const session = freshDir('session');
    // Target has residue; session is clean. Reading the session would mis-report.
    await writeStatus(
      target,
      { phases: [{ waves: [{ id: 'w1' }] }] },
      { waves: { w1: { status: 'pending' } } },
    );
    process.env.CLAUDE_PROJECT_DIR = session; // deliberately the WRONG dir
    setExecMock(gitMock({ locals: [], remotes: [] }));
    const parsed = parseResult(await handler.execute({ root: target }));
    expect(parsed.state).toBe('residue_found');
    expect(parsed.residue.pending_waves).toEqual(['w1']);
  });

  test('persisted_unstarted — plan persisted but never launched (no state, no kahuna) → residue_found with plan_id', async () => {
    // cc-workflow#716 AC-4: wave_campaign_precheck subsumes the old multi-phase
    // guard, so a persisted-but-unstarted plan (phases-waves.json with a plan_id,
    // all waves pending, no state.json, no kahuna branch) MUST surface as
    // residue_found — not clean — and carry plan_id sourced from the plan file.
    const dir = freshDir('unstarted');
    await writeStatus(dir, { plan_id: 321, phases: [{ waves: [{ id: 'w1' }, { id: 'w2' }] }] }, null);
    process.env.CLAUDE_PROJECT_DIR = dir;
    setExecMock(gitMock({ locals: [], remotes: [] }));
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.state).toBe('residue_found');
    expect(parsed.classification).toBe('ambiguous'); // all-pending → human decides
    expect(parsed.residue.plan_id).toBe(321);
    expect(parsed.residue.pending_waves).toEqual(['w1', 'w2']);
    expect(parsed.residue.promoted_waves).toEqual([]);
    expect(parsed.residue.kahuna_branches).toEqual([]);
  });

  test('schema_validation — rejects unknown fields', async () => {
    process.env.CLAUDE_PROJECT_DIR = freshDir('schema');
    const parsed = parseResult(await handler.execute({ foo: 'bar' }));
    expect(parsed.ok).toBe(false);
  });
});
