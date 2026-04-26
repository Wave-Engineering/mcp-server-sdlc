import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
//
// ci_run_logs now dispatches through the platform adapter (Story 2.12 / #306).
// The per-platform adapters call subprocess via `runArgv`, which shell-escapes
// its argv (`'gh' 'run' 'view' '12345' '--log-failed'`). The `unquote` shim
// strips that quoting so test match-keys can stay as plain strings — same
// pattern as tests/ci_failed_jobs.test.ts and tests/pr_files.test.ts.
//
// Integration coverage (IT-01, IT-04, IT-05): schema validation, handler
// envelope shape, platform dispatch, truncation composition, and cross-repo
// `repo` flag forwarding. Subprocess-boundary argv assertions live in the
// colocated adapter tests (lib/adapters/ci-run-logs-{github,gitlab}.test.ts).
// Direct `truncateLogs` unit tests live in lib/shared/truncate-logs.test.ts.

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: ciRunLogsHandler } = await import('../handlers/ci_run_logs.ts');

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

function makeLines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n');
}

beforeEach(resetMocks);
afterEach(resetMocks);

describe('ci_run_logs handler', () => {
  test('exports valid HandlerDef shape', () => {
    expect(ciRunLogsHandler.name).toBe('ci_run_logs');
    expect(typeof ciRunLogsHandler.execute).toBe('function');
    expect(ciRunLogsHandler.description).toBeTruthy();
  });

  test('invalid args — returns error result', async () => {
    const result = await ciRunLogsHandler.execute({ run_id: 'not-a-number' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
  });

  // --- GitHub platform ---

  test('github — failed-only logs, short content (no truncation)', async () => {
    const logContent = makeLines(10);
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (flat.includes('gh run view') && flat.includes('--log-failed')) return logContent;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 12345 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.run_id).toBe(12345);
    expect(parsed.job_id).toBeNull();
    expect(parsed.truncated).toBe(false);
    expect(parsed.line_count).toBe(10);
    expect(parsed.logs).toBe(logContent);
    expect(parsed.url as string).toContain('org/repo');
    expect(parsed.url as string).toContain('12345');
  });

  test('github — uses --log (not --log-failed) when failed_only=false', async () => {
    let sawFullLog = false;
    let sawFailedOnly = false;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (flat.includes('gh run view')) {
        if (flat.includes('--log-failed')) sawFailedOnly = true;
        if (flat.includes('--log') && !flat.includes('--log-failed')) sawFullLog = true;
        return 'some logs\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 1, failed_only: false });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(sawFullLog).toBe(true);
    expect(sawFailedOnly).toBe(false);
  });

  test('github — specific job_id passes --job flag', async () => {
    let jobFlagSeen = false;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (flat.includes('gh run view')) {
        if (flat.includes('--job 999')) jobFlagSeen = true;
        return 'job logs\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 42, job_id: 999 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(jobFlagSeen).toBe(true);
    expect(parsed.job_id).toBe(999);
  });

  test('github — long log triggers truncation at max_lines (composition)', async () => {
    // IT-style assertion: the handler composes truncateLogs against the raw
    // adapter response. Proof: logs > max_lines yields `truncated: true`
    // and `line_count` reflects the ORIGINAL size.
    const longLog = makeLines(500);
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (flat.includes('gh run view')) return longLog;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 1, max_lines: 100 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.line_count).toBe(500);
    const logs = parsed.logs as string;
    expect(logs).toContain('lines omitted');
    expect(logs).toContain('line-1');
    expect(logs).toContain('line-500');
    expect(logs).not.toContain('line-250');
  });

  test('github — hard cap at 10000 overrides caller max_lines', async () => {
    const hugeLog = makeLines(50000);
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (flat.includes('gh run view')) return hugeLog;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    // Caller asks for 20000 but hard cap is 10000.
    const result = await ciRunLogsHandler.execute({ run_id: 1, max_lines: 20000 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.line_count).toBe(50000);

    const logs = parsed.logs as string;
    const outLineCount = logs.split('\n').length;
    expect(outLineCount).toBeLessThanOrEqual(10001);
    expect(outLineCount).toBeGreaterThan(9000);
    expect(logs).toContain('lines omitted');
  });

  // --- GitLab platform ---

  test('gitlab — with explicit job_id uses glab ci trace directly', async () => {
    const logContent = makeLines(5, 'gl');
    let tracedJob = 0;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (flat.startsWith('glab ci trace')) {
        const m = /glab ci trace (\d+)/.exec(flat);
        if (m) tracedJob = parseInt(m[1], 10);
        return logContent;
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 10, job_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(tracedJob).toBe(77);
    expect(parsed.job_id).toBe(77);
    expect(parsed.truncated).toBe(false);
    expect(parsed.line_count).toBe(5);
    expect(parsed.url as string).toContain('grp/proj');
    expect(parsed.url as string).toContain('/jobs/77');
  });

  test('gitlab — without job_id fetches first failed job from pipeline', async () => {
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (flat.includes('glab api') && flat.includes('/pipelines/55/jobs')) {
        return JSON.stringify([
          { id: 100, status: 'success' },
          { id: 101, status: 'failed' },
          { id: 102, status: 'failed' },
        ]);
      }
      if (flat.startsWith('glab ci trace 101')) {
        return 'failed job log\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 55 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.job_id).toBe(101);
    expect(parsed.truncated).toBe(false);
    expect(parsed.logs).toBe('failed job log');
  });

  test('gitlab — no failed job in pipeline returns error', async () => {
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (flat.includes('glab api') && flat.includes('/pipelines/99/jobs')) {
        return JSON.stringify([{ id: 1, status: 'success' }]);
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 99 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('no failed job');
  });

  // --- Issue #197: cross-repo orchestration via explicit `repo` ---

  test('github_explicit_repo — appends --repo flag to gh run view', async () => {
    let sawRepoFlag = false;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote'))
        return 'https://github.com/cwd-org/cwd-repo.git\n';
      if (flat.includes('gh run view')) {
        if (flat.includes('--repo other-org/other-repo')) sawRepoFlag = true;
        return 'logline\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({
      run_id: 321,
      repo: 'other-org/other-repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(sawRepoFlag).toBe(true);
  });

  test('github_explicit_repo — URL construction uses explicit slug not cwd', async () => {
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote'))
        return 'https://github.com/cwd-org/cwd-repo.git\n';
      if (flat.includes('gh run view')) return 'logline\n';
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({
      run_id: 654,
      repo: 'explicit-org/explicit-repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    const url = parsed.url as string;
    expect(url).toContain('explicit-org/explicit-repo');
    expect(url).not.toContain('cwd-org/cwd-repo');
  });

  test('gitlab_explicit_repo — pipelines URL + trace use explicit slug', async () => {
    let sawExplicitPipelinesPath = false;
    let sawTraceRepoFlag = false;
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote'))
        return 'https://gitlab.com/cwd-org/cwd-repo.git\n';
      if (
        flat.includes('glab api') &&
        flat.includes('projects/other-org%2Fother-repo/pipelines/99/jobs')
      ) {
        sawExplicitPipelinesPath = true;
        return JSON.stringify([{ id: 701, status: 'failed' }]);
      }
      if (flat.startsWith('glab ci trace 701')) {
        if (flat.includes('-R other-org/other-repo')) sawTraceRepoFlag = true;
        return 'failing log\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({
      run_id: 99,
      repo: 'other-org/other-repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(sawExplicitPipelinesPath).toBe(true);
    expect(sawTraceRepoFlag).toBe(true);
    const url = parsed.url as string;
    expect(url).toContain('other-org/other-repo');
  });

  test('gitlab — long log triggers truncation (composition)', async () => {
    const longLog = makeLines(1200);
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (flat.startsWith('glab ci trace')) return longLog;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({
      run_id: 1,
      job_id: 5,
      max_lines: 200,
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.line_count).toBe(1200);
    expect(parsed.logs as string).toContain('lines omitted');
  });

  // --- exec error surfaces as ok:false ---
  test('github_exec_error — surfaces gh command failure as ok:false', async () => {
    execMockFn = (cmd: string) => {
      const flat = unquote(cmd);
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (flat.includes('gh run view')) {
        throw new Error('gh: run not found');
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await ciRunLogsHandler.execute({ run_id: 404 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('gh run view failed');
  });
});
