import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const handlerModule = await import('../handlers/ci_run_logs.ts');
const handler = handlerModule.default;
const { truncateLogs } = handlerModule;

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeLines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n');
}

describe('ci_run_logs handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('ci_run_logs');
    expect(typeof handler.execute).toBe('function');
    expect(handler.description).toBeTruthy();
  });

  test('invalid args — returns error result', async () => {
    const result = await handler.execute({ run_id: 'not-a-number' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
  });

  // --- GitHub platform ---

  test('github — failed-only logs, short content (no truncation)', async () => {
    const logContent = makeLines(10);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh run view') && cmd.includes('--log-failed')) return logContent;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 12345 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.run_id).toBe(12345);
    expect(parsed.job_id).toBeNull();
    expect(parsed.truncated).toBe(false);
    expect(parsed.line_count).toBe(10);
    expect(parsed.logs).toBe(logContent);
    expect((parsed.url as string)).toContain('org/repo');
    expect((parsed.url as string)).toContain('12345');
  });

  test('github — uses --log (not --log-failed) when failed_only=false', async () => {
    let sawFullLog = false;
    let sawFailedOnly = false;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh run view')) {
        if (cmd.includes('--log-failed')) sawFailedOnly = true;
        if (cmd.includes('--log') && !cmd.includes('--log-failed')) sawFullLog = true;
        return 'some logs\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 1, failed_only: false });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(sawFullLog).toBe(true);
    expect(sawFailedOnly).toBe(false);
  });

  test('github — specific job_id passes --job flag', async () => {
    let jobFlagSeen = false;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh run view')) {
        if (cmd.includes('--job 999')) jobFlagSeen = true;
        return 'job logs\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 42, job_id: 999 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(jobFlagSeen).toBe(true);
    expect(parsed.job_id).toBe(999);
  });

  test('github — long log triggers truncation at max_lines', async () => {
    const longLog = makeLines(500);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh run view')) return longLog;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 1, max_lines: 100 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.line_count).toBe(500);
    const logs = parsed.logs as string;
    expect(logs).toContain('lines omitted');
    // Head and tail should both be present
    expect(logs).toContain('line-1');
    expect(logs).toContain('line-500');
    // A middle line should NOT be present
    expect(logs).not.toContain('line-250');
  });

  test('github — hard cap at 10000 overrides caller max_lines', async () => {
    const hugeLog = makeLines(50000);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh run view')) return hugeLog;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    // Caller asks for 20000 but hard cap is 10000
    const result = await handler.execute({ run_id: 1, max_lines: 20000 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.line_count).toBe(50000);

    // Output should be capped: ~10000 lines of content + 1 marker line
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
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (cmd.startsWith('glab ci trace')) {
        const m = /glab ci trace (\d+)/.exec(cmd);
        if (m) tracedJob = parseInt(m[1], 10);
        return logContent;
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 10, job_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(tracedJob).toBe(77);
    expect(parsed.job_id).toBe(77);
    expect(parsed.truncated).toBe(false);
    expect(parsed.line_count).toBe(5);
    expect((parsed.url as string)).toContain('grp/proj');
    expect((parsed.url as string)).toContain('/jobs/77');
  });

  test('gitlab — without job_id fetches first failed job from pipeline', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (cmd.includes('glab api') && cmd.includes('/pipelines/55/jobs')) {
        return JSON.stringify([
          { id: 100, status: 'success' },
          { id: 101, status: 'failed' },
          { id: 102, status: 'failed' },
        ]);
      }
      if (cmd.startsWith('glab ci trace 101')) {
        return 'failed job log\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 55 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.job_id).toBe(101);
    expect(parsed.truncated).toBe(false);
    expect(parsed.logs).toBe('failed job log');
  });

  test('gitlab — no failed job in pipeline returns error', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (cmd.includes('glab api') && cmd.includes('/pipelines/99/jobs')) {
        return JSON.stringify([{ id: 1, status: 'success' }]);
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 99 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect((parsed.error as string)).toContain('no failed job');
  });

  // --- Issue #197: cross-repo orchestration via explicit `repo` ---

  test('github_explicit_repo — appends --repo flag to gh run view', async () => {
    let sawRepoFlag = false;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/cwd-org/cwd-repo.git\n';
      if (cmd.includes('gh run view')) {
        if (cmd.includes('--repo other-org/other-repo')) sawRepoFlag = true;
        return 'logline\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({
      run_id: 321,
      repo: 'other-org/other-repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(sawRepoFlag).toBe(true);
  });

  test('github_explicit_repo — URL construction uses explicit slug not cwd', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/cwd-org/cwd-repo.git\n';
      if (cmd.includes('gh run view')) return 'logline\n';
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({
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
      if (cmd.startsWith('git remote'))
        return 'https://gitlab.com/cwd-org/cwd-repo.git\n';
      if (
        cmd.includes('glab api') &&
        cmd.includes(
          'projects/other-org%2Fother-repo/pipelines/99/jobs',
        )
      ) {
        sawExplicitPipelinesPath = true;
        return JSON.stringify([{ id: 701, status: 'failed' }]);
      }
      if (cmd.startsWith('glab ci trace 701')) {
        if (cmd.includes('-R other-org/other-repo')) sawTraceRepoFlag = true;
        return 'failing log\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({
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

  test('gitlab — long log triggers truncation', async () => {
    const longLog = makeLines(1200);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/grp/proj.git\n';
      if (cmd.startsWith('glab ci trace')) return longLog;
      throw new Error(`unexpected cmd: ${cmd}`);
    };

    const result = await handler.execute({ run_id: 1, job_id: 5, max_lines: 200 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.line_count).toBe(1200);
    expect((parsed.logs as string)).toContain('lines omitted');
  });
});

// --- truncateLogs unit tests (direct) ---

describe('truncateLogs', () => {
  test('short log — no truncation', () => {
    const r = truncateLogs('a\nb\nc\n', 100);
    expect(r.truncated).toBe(false);
    expect(r.line_count).toBe(3);
    expect(r.logs).toBe('a\nb\nc');
  });

  test('exact size match — no truncation', () => {
    const r = truncateLogs('a\nb\nc', 3);
    expect(r.truncated).toBe(false);
    expect(r.line_count).toBe(3);
  });

  test('over max_lines — head+tail split with marker', () => {
    const input = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
    const r = truncateLogs(input, 6);
    expect(r.truncated).toBe(true);
    expect(r.line_count).toBe(20);
    // 6/2 = 3 head + 3 tail + marker line
    const outLines = r.logs.split('\n');
    expect(outLines.length).toBe(7);
    expect(outLines[0]).toBe('L0');
    expect(outLines[1]).toBe('L1');
    expect(outLines[2]).toBe('L2');
    expect(outLines[3]).toContain('14 lines omitted');
    expect(outLines[4]).toBe('L17');
    expect(outLines[5]).toBe('L18');
    expect(outLines[6]).toBe('L19');
  });

  test('hard cap — caller max_lines above 10000 capped to 10000', () => {
    const input = Array.from({ length: 50000 }, (_, i) => `L${i}`).join('\n');
    const r = truncateLogs(input, 20000);
    expect(r.truncated).toBe(true);
    expect(r.line_count).toBe(50000);
    const outLines = r.logs.split('\n');
    // 10000 lines kept + 1 marker
    expect(outLines.length).toBe(10001);
  });

  test('empty input', () => {
    const r = truncateLogs('', 100);
    expect(r.truncated).toBe(false);
    expect(r.line_count).toBe(0);
  });
});
