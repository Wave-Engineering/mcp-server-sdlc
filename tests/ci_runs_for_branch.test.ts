import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
// Individual tests register command substrings and the payloads they should return.

let execRegistry: Record<string, string> = {};
const execCalls: string[] = [];

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  for (const [key, value] of Object.entries(execRegistry)) {
    if (cmd.includes(key)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// Import AFTER the mock is registered
const { default: handler } = await import('../handlers/ci_runs_for_branch.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = {};
  execCalls.length = 0;
});

describe('ci_runs_for_branch handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('ci_runs_for_branch');
    expect(typeof handler.execute).toBe('function');
  });

  test('schema_validation — rejects missing branch', async () => {
    const result = await handler.execute({});
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema_validation — rejects empty branch', async () => {
    const result = await handler.execute({ branch: '' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema_validation — rejects invalid status', async () => {
    const result = await handler.execute({ branch: 'feature/88-x', status: 'bogus' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  // ---------- GITHUB ----------

  test('github_default_limit — uses limit=10 and no --status when status is all', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = JSON.stringify([
      {
        databaseId: 111,
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        headSha: 'abc123',
        url: 'https://github.com/org/repo/actions/runs/111',
        createdAt: '2026-04-07T12:00:00Z',
      },
      {
        databaseId: 110,
        name: 'ci',
        status: 'completed',
        conclusion: 'failure',
        headSha: 'def456',
        url: 'https://github.com/org/repo/actions/runs/110',
        createdAt: '2026-04-07T11:00:00Z',
      },
    ]);

    const result = await handler.execute({ branch: 'feature/88-ci' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const runs = data.runs as RunRecord[];
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      run_id: 111,
      workflow_name: 'ci',
      status: 'completed',
      conclusion: 'success',
      sha: 'abc123',
      url: 'https://github.com/org/repo/actions/runs/111',
      created_at: '2026-04-07T12:00:00Z',
    });

    // Newest first preserved from CLI order
    expect(runs[0].run_id).toBeGreaterThan(runs[1].run_id);

    // Default limit=10 applied
    const runListCall = execCalls.find(c => c.includes('gh run list'));
    expect(runListCall).toBeDefined();
    expect(runListCall).toContain('--limit 10');
    expect(runListCall).not.toContain('--status');
  });

  test('github_status_filter — success maps to --status success', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = JSON.stringify([
      {
        databaseId: 200,
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        headSha: 'sha200',
        url: 'https://github.com/org/repo/actions/runs/200',
        createdAt: '2026-04-07T10:00:00Z',
      },
    ]);

    const result = await handler.execute({
      branch: 'feature/88-ci',
      status: 'success',
      limit: 5,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const runListCall = execCalls.find(c => c.includes('gh run list'));
    expect(runListCall).toContain('--status success');
    expect(runListCall).toContain('--limit 5');
  });

  test('github_status_filter — failure maps to --status failure', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = '[]';

    await handler.execute({ branch: 'feature/88-ci', status: 'failure' });

    const runListCall = execCalls.find(c => c.includes('gh run list'));
    expect(runListCall).toContain('--status failure');
  });

  test('github_status_filter — in_progress maps to --status in_progress', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = '[]';

    await handler.execute({ branch: 'feature/88-ci', status: 'in_progress' });

    const runListCall = execCalls.find(c => c.includes('gh run list'));
    expect(runListCall).toContain('--status in_progress');
  });

  test('github_empty_branch — empty result array returns ok with runs=[]', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = '[]';

    const result = await handler.execute({ branch: 'feature/99-never-ran' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.runs).toEqual([]);
  });

  test('github_error — surfaces exec failure as ok:false', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    // No 'gh run list' registered — mockExec throws, handler should catch it.

    const result = await handler.execute({ branch: 'feature/88-ci' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });

  // ---------- GITLAB ----------

  test('gitlab_default_limit — uses per-page=10 and no --status when status is all', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = JSON.stringify([
      {
        id: 5001,
        name: 'pipeline',
        ref: 'feature/88-ci',
        status: 'success',
        sha: 'gitlabsha1',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/5001',
        created_at: '2026-04-07T12:00:00Z',
      },
      {
        id: 5000,
        ref: 'feature/88-ci',
        status: 'running',
        sha: 'gitlabsha0',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/5000',
        created_at: '2026-04-07T11:00:00Z',
        source: 'push',
      },
    ]);

    const result = await handler.execute({ branch: 'feature/88-ci' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const runs = data.runs as RunRecord[];
    expect(runs).toHaveLength(2);

    // First (newest) is the success pipeline
    expect(runs[0]).toMatchObject({
      run_id: 5001,
      workflow_name: 'pipeline',
      status: 'success',
      conclusion: 'success',
      sha: 'gitlabsha1',
      url: 'https://gitlab.com/org/repo/-/pipelines/5001',
      created_at: '2026-04-07T12:00:00Z',
    });

    // Running pipeline has null conclusion and falls back to source for name
    expect(runs[1].conclusion).toBeNull();
    expect(runs[1].workflow_name).toBe('push');

    const listCall = execCalls.find(c => c.includes('glab ci list'));
    expect(listCall).toBeDefined();
    expect(listCall).toContain('--per-page 10');
    expect(listCall).not.toContain('--status');
  });

  test('gitlab_status_filter — failure translates to --status failed', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = JSON.stringify([
      {
        id: 6000,
        name: 'pipeline',
        status: 'failed',
        sha: 'deadbeef',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/6000',
        created_at: '2026-04-07T09:00:00Z',
      },
    ]);

    const result = await handler.execute({
      branch: 'feature/88-ci',
      status: 'failure',
      limit: 3,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const listCall = execCalls.find(c => c.includes('glab ci list'));
    expect(listCall).toContain('--status failed');
    expect(listCall).toContain('--per-page 3');

    const runs = data.runs as RunRecord[];
    expect(runs[0].conclusion).toBe('failed');
  });

  test('gitlab_status_filter — in_progress translates to --status running', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = '[]';

    await handler.execute({ branch: 'feature/88-ci', status: 'in_progress' });

    const listCall = execCalls.find(c => c.includes('glab ci list'));
    expect(listCall).toContain('--status running');
  });

  test('gitlab_status_filter — success stays as --status success', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = '[]';

    await handler.execute({ branch: 'feature/88-ci', status: 'success' });

    const listCall = execCalls.find(c => c.includes('glab ci list'));
    expect(listCall).toContain('--status success');
  });

  test('gitlab_empty_branch — empty pipeline list returns ok with runs=[]', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = '[]';

    const result = await handler.execute({ branch: 'feature/99-never-ran' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.runs).toEqual([]);
  });
});

interface RunRecord {
  run_id: number;
  workflow_name: string;
  status: string;
  conclusion: string | null;
  sha: string;
  url: string;
  created_at: string;
}
