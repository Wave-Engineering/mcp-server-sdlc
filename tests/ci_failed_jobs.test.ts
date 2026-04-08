import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: ciFailedJobsHandler } = await import('../handlers/ci_failed_jobs.ts');

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

  // --- GitHub: mixed success/fail ---
  test('github_mixed — returns only non-success completed jobs', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh run view 12345 --json jobs')) {
        return JSON.stringify({
          jobs: [
            {
              databaseId: 101,
              name: 'lint',
              status: 'completed',
              conclusion: 'success',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:01:00Z',
              url: 'https://github.com/org/repo/actions/runs/12345/job/101',
            },
            {
              databaseId: 102,
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:02:00Z',
              url: 'https://github.com/org/repo/actions/runs/12345/job/102',
            },
            {
              databaseId: 103,
              name: 'build',
              status: 'completed',
              conclusion: 'timed_out',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:10:00Z',
              url: 'https://github.com/org/repo/actions/runs/12345/job/103',
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
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe('test');
    expect(jobs[0].conclusion).toBe('failure');
    expect(jobs[0].job_id).toBe(102);
    expect(jobs[0].stage).toBeNull();
    expect(jobs[0].started_at).toBe('2025-01-01T00:00:00Z');
    expect(jobs[0].finished_at).toBe('2025-01-01T00:02:00Z');
    expect(jobs[0].url).toBe('https://github.com/org/repo/actions/runs/12345/job/102');
    expect(jobs[1].name).toBe('build');
    expect(jobs[1].conclusion).toBe('timed_out');
  });

  // --- GitHub: all success → empty ---
  test('github_all_success — returns empty list', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh run view 999 --json jobs')) {
        return JSON.stringify({
          jobs: [
            {
              databaseId: 1,
              name: 'lint',
              status: 'completed',
              conclusion: 'success',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:01:00Z',
              url: 'https://github.com/org/repo/actions/runs/999/job/1',
            },
            {
              databaseId: 2,
              name: 'test',
              status: 'completed',
              conclusion: 'success',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:01:00Z',
              url: 'https://github.com/org/repo/actions/runs/999/job/2',
            },
          ],
        });
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 999 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.run_id).toBe(999);
    expect(data.failed_jobs).toEqual([]);
  });

  // --- GitHub: all failed ---
  test('github_all_failed — returns every job', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh run view 777 --json jobs')) {
        return JSON.stringify({
          jobs: [
            {
              databaseId: 10,
              name: 'lint',
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:01:00Z',
              url: 'https://github.com/org/repo/actions/runs/777/job/10',
            },
            {
              databaseId: 11,
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:02:00Z',
              url: 'https://github.com/org/repo/actions/runs/777/job/11',
            },
          ],
        });
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 777 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const jobs = data.failed_jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe('lint');
    expect(jobs[1].name).toBe('test');
  });

  // --- GitHub: excludes in-progress jobs (status != completed) ---
  test('github_skips_in_progress — excludes jobs that have not completed', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh run view 555 --json jobs')) {
        return JSON.stringify({
          jobs: [
            {
              databaseId: 20,
              name: 'still-running',
              status: 'in_progress',
              conclusion: null,
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: null,
              url: 'https://github.com/org/repo/actions/runs/555/job/20',
            },
            {
              databaseId: 21,
              name: 'done-failed',
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2025-01-01T00:00:00Z',
              completedAt: '2025-01-01T00:02:00Z',
              url: 'https://github.com/org/repo/actions/runs/555/job/21',
            },
          ],
        });
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 555 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const jobs = data.failed_jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('done-failed');
  });

  // --- GitLab: mixed success/fail ---
  test('gitlab_mixed — returns only failed jobs with stage field populated', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/org/repo.git\n';
      if (cmd.startsWith('glab api projects/:id/pipelines/42/jobs')) {
        return JSON.stringify([
          {
            id: 201,
            name: 'lint',
            status: 'success',
            stage: 'test',
            started_at: '2025-02-01T00:00:00Z',
            finished_at: '2025-02-01T00:01:00Z',
            web_url: 'https://gitlab.com/org/repo/-/jobs/201',
          },
          {
            id: 202,
            name: 'unit-test',
            status: 'failed',
            stage: 'test',
            started_at: '2025-02-01T00:00:00Z',
            finished_at: '2025-02-01T00:03:00Z',
            web_url: 'https://gitlab.com/org/repo/-/jobs/202',
          },
          {
            id: 203,
            name: 'deploy',
            status: 'failed',
            stage: 'deploy',
            started_at: '2025-02-01T00:04:00Z',
            finished_at: '2025-02-01T00:05:00Z',
            web_url: 'https://gitlab.com/org/repo/-/jobs/203',
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
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe('unit-test');
    expect(jobs[0].stage).toBe('test');
    expect(jobs[0].conclusion).toBe('failure');
    expect(jobs[0].job_id).toBe(202);
    expect(jobs[0].started_at).toBe('2025-02-01T00:00:00Z');
    expect(jobs[0].finished_at).toBe('2025-02-01T00:03:00Z');
    expect(jobs[0].url).toBe('https://gitlab.com/org/repo/-/jobs/202');
    expect(jobs[1].name).toBe('deploy');
    expect(jobs[1].stage).toBe('deploy');
  });

  // --- GitLab: all success → empty ---
  test('gitlab_all_success — returns empty list', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/org/repo.git\n';
      if (cmd.startsWith('glab api projects/:id/pipelines/1/jobs')) {
        return JSON.stringify([
          {
            id: 1,
            name: 'lint',
            status: 'success',
            stage: 'test',
            started_at: '2025-02-01T00:00:00Z',
            finished_at: '2025-02-01T00:01:00Z',
            web_url: 'https://gitlab.com/org/repo/-/jobs/1',
          },
        ]);
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 1 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.failed_jobs).toEqual([]);
  });

  // --- GitLab: all failed ---
  test('gitlab_all_failed — returns every job', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/org/repo.git\n';
      if (cmd.startsWith('glab api projects/:id/pipelines/88/jobs')) {
        return JSON.stringify([
          {
            id: 301,
            name: 'lint',
            status: 'failed',
            stage: 'test',
            started_at: '2025-02-01T00:00:00Z',
            finished_at: '2025-02-01T00:01:00Z',
            web_url: 'https://gitlab.com/org/repo/-/jobs/301',
          },
          {
            id: 302,
            name: 'unit-test',
            status: 'failed',
            stage: 'test',
            started_at: '2025-02-01T00:00:00Z',
            finished_at: '2025-02-01T00:02:00Z',
            web_url: 'https://gitlab.com/org/repo/-/jobs/302',
          },
        ]);
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 88 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const jobs = data.failed_jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0].conclusion).toBe('failure');
    expect(jobs[1].conclusion).toBe('failure');
  });

  // --- GitLab: skips non-failed statuses (canceled, skipped, pending) ---
  test('gitlab_skips_non_failed — excludes canceled, skipped, pending jobs', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/org/repo.git\n';
      if (cmd.startsWith('glab api projects/:id/pipelines/66/jobs')) {
        return JSON.stringify([
          { id: 1, name: 'cancelled-job', status: 'canceled', stage: 'test' },
          { id: 2, name: 'pending-job', status: 'pending', stage: 'test' },
          { id: 3, name: 'skipped-job', status: 'skipped', stage: 'test' },
          {
            id: 4,
            name: 'real-failure',
            status: 'failed',
            stage: 'test',
            started_at: null,
            finished_at: null,
            web_url: 'https://gitlab.com/org/repo/-/jobs/4',
          },
        ]);
      }
      throw new Error(`Unexpected exec: ${cmd}`);
    };

    const result = await ciFailedJobsHandler.execute({ run_id: 66 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const jobs = data.failed_jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('real-failure');
    expect(jobs[0].started_at).toBeNull();
    expect(jobs[0].finished_at).toBeNull();
  });

  // --- exec error surfaces as ok:false ---
  test('exec_error — surfaces platform command failure as ok:false', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh run view')) {
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
