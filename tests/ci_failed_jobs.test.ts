import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
//
// ci_failed_jobs now dispatches through the platform adapter (Story 2.11 /
// #305). The per-platform adapters call subprocess via `runArgv`, which
// shell-escapes its argv (`'gh' 'run' 'view' '12345' '--json' 'jobs'`). The
// `unquote` shim strips that quoting so test match-keys can stay as plain
// `gh run view 12345 --json jobs` strings — same pattern adopted by
// tests/pr_files.test.ts.
//
// Integration coverage: schema validation, handler envelope shape, cross-repo
// (`repo` flag forwarding). Subprocess-boundary argv assertions live in the
// colocated adapter tests (lib/adapters/ci-failed-jobs-{github,gitlab}.test.ts).

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: ciFailedJobsHandler } = await import('../handlers/ci_failed_jobs.ts');

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

beforeEach(resetMocks);

describe('ci_failed_jobs handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(ciFailedJobsHandler.name).toBe('ci_failed_jobs');
    expect(typeof ciFailedJobsHandler.execute).toBe('function');
  });

  test('schema_validation — rejects missing run_id', async () => {
    const result = await ciFailedJobsHandler.execute({});
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema_validation — rejects unknown fields', async () => {
    const result = await ciFailedJobsHandler.execute({ run_id: 1, foo: 'bar' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema_validation — rejects non-positive run_id', async () => {
    const result = await ciFailedJobsHandler.execute({ run_id: 0 });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  // --- End-to-end: handler → adapter → subprocess → envelope ---
  test('github_end_to_end — returns failed jobs in standard envelope', async () => {
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (flat.includes('gh run view 12345 --json jobs')) {
        return JSON.stringify({
          jobs: [
            {
              databaseId: 102,
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:02:00Z',
              url: 'https://github.com/org/repo/actions/runs/12345/job/102',
            },
          ],
        });
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 12345 });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.run_id).toBe(12345);
    const jobs = data.failed_jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('test');
    expect(jobs[0].conclusion).toBe('failure');
    expect(jobs[0].stage).toBeNull();
  });

  test('gitlab_end_to_end — returns failed jobs with stage populated', async () => {
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/org/repo.git\n';
      if (flat.includes('glab api projects/:id/pipelines/42/jobs')) {
        return JSON.stringify([
          {
            id: 202,
            name: 'unit-test',
            status: 'failed',
            stage: 'test',
            started_at: '2025-02-01T00:00:00Z',
            finished_at: '2025-02-01T00:03:00Z',
            web_url: 'https://gitlab.com/org/repo/-/jobs/202',
          },
        ]);
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 42 });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.run_id).toBe(42);
    const jobs = data.failed_jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('unit-test');
    expect(jobs[0].stage).toBe('test');
    expect(jobs[0].conclusion).toBe('failure');
  });

  // --- Issue #197: cross-repo orchestration via explicit `repo` ---

  test('github_explicit_repo — appends --repo flag to gh run view', async () => {
    let sawRepoFlag = false;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote'))
        return 'https://github.com/cwd-org/cwd-repo.git\n';
      if (flat.includes('gh run view 777 --json jobs')) {
        if (flat.includes('--repo other-org/other-repo')) sawRepoFlag = true;
        return JSON.stringify({
          jobs: [
            {
              databaseId: 1,
              name: 'unit',
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:01:00Z',
              url: 'https://github.com/other-org/other-repo/actions/runs/777/job/1',
            },
          ],
        });
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({
      run_id: 777,
      repo: 'other-org/other-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(sawRepoFlag).toBe(true);
  });

  test('gitlab_explicit_repo — replaces :id with encoded explicit slug', async () => {
    let sawExplicitPath = false;
    let sawColonId = false;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote'))
        return 'https://gitlab.com/cwd-org/cwd-repo.git\n';
      if (flat.includes('glab api')) {
        if (flat.includes('projects/other-org%2Fother-repo/pipelines/101/jobs'))
          sawExplicitPath = true;
        if (flat.includes('projects/:id/pipelines/101/jobs')) sawColonId = true;
        return JSON.stringify([
          {
            id: 501,
            name: 'unit',
            status: 'failed',
            stage: 'test',
            started_at: null,
            finished_at: null,
            web_url: 'https://gitlab.com/other-org/other-repo/-/jobs/501',
          },
        ]);
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({
      run_id: 101,
      repo: 'other-org/other-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(sawExplicitPath).toBe(true);
    expect(sawColonId).toBe(false);
  });

  test('regression_no_repo — preserves :id shorthand when repo not provided', async () => {
    let sawColonId = false;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote'))
        return 'https://gitlab.com/org/repo.git\n';
      if (flat.includes('glab api')) {
        if (flat.includes('projects/:id/pipelines/202/jobs')) sawColonId = true;
        return JSON.stringify([]);
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 202 });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(sawColonId).toBe(true);
  });

  // --- exec error surfaces as ok:false ---
  test('exec_error — surfaces platform command failure as ok:false', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh') && cmd.includes('run') && cmd.includes('view')) {
        throw new Error('gh: run not found');
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 404 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('gh: run not found');
  });
});
