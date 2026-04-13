import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock child_process for platform detection (detectPlatform) and record-mr calls.
let execMockFn: (cmd: string) => string = () => '';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { reconcile, default: handler } = await import(
  '../handlers/wave_reconcile_mrs.ts'
);

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function setupFixture(plan: object, state: object) {
  fixtureDir = `/tmp/wave-reconcile-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const statusDir = `${fixtureDir}/.claude/status`;
  await Bun.write(`${statusDir}/phases-waves.json`, JSON.stringify(plan));
  await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
}

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
  fixtureDir = '';
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

const PLAN = {
  phases: [
    {
      waves: [
        {
          id: 'w1',
          issues: [{ number: 10 }, { number: 11 }, { number: 12 }],
        },
      ],
    },
  ],
};

describe('wave_reconcile_mrs handler', () => {
  beforeEach(resetMocks);
  afterEach(restoreEnv);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_reconcile_mrs');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy path — backfills missing mr_urls from merged PRs', async () => {
    const state = {
      current_wave: 'w1',
      waves: {
        w1: { status: 'in_progress', mr_urls: {} },
      },
    };
    await setupFixture(PLAN, state);

    // Mock: detectPlatform → github, gh pr list returns merged PRs
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh pr list'))
        return JSON.stringify([
          {
            number: 50,
            url: 'https://github.com/org/repo/pull/50',
            headRefName: 'feature/10-some-feature',
          },
          {
            number: 51,
            url: 'https://github.com/org/repo/pull/51',
            headRefName: 'feature/11-another-feature',
          },
        ]);
      // wave-status record-mr calls — return success
      if (cmd.startsWith('wave-status record-mr')) return '';
      return '';
    };

    const recordMrCalls: string[] = [];
    const deps = {
      execFn: (cmd: string) => {
        if (cmd.startsWith('wave-status record-mr')) {
          recordMrCalls.push(cmd);
        }
        return execMockFn(cmd);
      },
    };

    const result = await reconcile({}, deps);
    expect(result.ok).toBe(true);
    expect(result.wave_id).toBe('w1');
    expect(result.reconciled).toHaveLength(2);
    expect(result.reconciled[0].issue_number).toBe(10);
    expect(result.reconciled[0].mr_ref).toBe(
      'https://github.com/org/repo/pull/50',
    );
    expect(result.reconciled[1].issue_number).toBe(11);
    expect(result.already_recorded).toBe(0);
    expect(result.not_found).toEqual([12]);
    expect(recordMrCalls).toHaveLength(2);
  });

  test('already-recorded — skips issues that have mr_url', async () => {
    const state = {
      current_wave: 'w1',
      waves: {
        w1: {
          status: 'completed',
          mr_urls: {
            '10': 'https://github.com/org/repo/pull/50',
            '11': 'https://github.com/org/repo/pull/51',
          },
        },
      },
    };
    await setupFixture(PLAN, state);

    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh pr list')) return JSON.stringify([]);
      return '';
    };

    const deps = {
      execFn: (cmd: string) => execMockFn(cmd),
    };

    const result = await reconcile({}, deps);
    expect(result.ok).toBe(true);
    expect(result.already_recorded).toBe(2);
    expect(result.reconciled).toHaveLength(0);
    expect(result.not_found).toEqual([12]);
  });

  test('no matching PR — issue goes to not_found', async () => {
    const state = {
      current_wave: 'w1',
      waves: {
        w1: { status: 'in_progress', mr_urls: {} },
      },
    };
    await setupFixture(PLAN, state);

    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh pr list')) return JSON.stringify([]);
      return '';
    };

    const deps = {
      execFn: (cmd: string) => execMockFn(cmd),
    };

    const result = await reconcile({}, deps);
    expect(result.ok).toBe(true);
    expect(result.reconciled).toHaveLength(0);
    expect(result.not_found).toEqual([10, 11, 12]);
  });

  test('missing state files — returns structured error', async () => {
    fixtureDir = `/tmp/wave-reconcile-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;

    const deps = {
      execFn: (cmd: string) => execMockFn(cmd),
    };

    const result = await reconcile({}, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('state files not found');
  });

  test('idempotent — second call produces reconciled: []', async () => {
    const state = {
      current_wave: 'w1',
      waves: {
        w1: {
          status: 'completed',
          mr_urls: {
            '10': 'https://github.com/org/repo/pull/50',
            '11': 'https://github.com/org/repo/pull/51',
            '12': 'https://github.com/org/repo/pull/52',
          },
        },
      },
    };
    await setupFixture(PLAN, state);

    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      return '';
    };

    const deps = {
      execFn: (cmd: string) => execMockFn(cmd),
    };

    const result = await reconcile({}, deps);
    expect(result.ok).toBe(true);
    expect(result.reconciled).toHaveLength(0);
    expect(result.already_recorded).toBe(3);
    expect(result.not_found).toEqual([]);
  });
});
