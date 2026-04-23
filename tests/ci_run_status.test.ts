import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
// Individual tests populate execRegistry with prefix→output pairs.

let execRegistry: Record<string, string> = {};
let execCalls: string[] = [];
let execError: Error | null = null;

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  if (execError) throw execError;
  for (const [key, value] of Object.entries(execRegistry)) {
    if (cmd.includes(key)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// Import AFTER mock registration.
const { default: ciRunStatusHandler } = await import(
  '../handlers/ci_run_status.ts'
);

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = {};
  execCalls = [];
  execError = null;
});

describe('ci_run_status handler', () => {
  // --- GitHub: branch ref ---
  test('github_branch_ref — returns normalized run for branch lookup', async () => {
    execRegistry['git remote get-url origin'] =
      'https://github.com/org/repo.git';
    execRegistry['gh run list --branch'] = JSON.stringify([
      {
        databaseId: 12345,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/org/repo/actions/runs/12345',
        headBranch: 'feature/42-thing',
        headSha: 'abcdef0123456789abcdef0123456789abcdef01',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:05:00Z',
      },
    ]);

    const result = await ciRunStatusHandler.execute({
      ref: 'feature/42-thing',
    });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const run = data.data as Record<string, unknown>;
    expect(run.run_id).toBe(12345);
    expect(run.workflow_name).toBe('CI');
    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('success');
    expect(run.url).toBe('https://github.com/org/repo/actions/runs/12345');
    expect(run.ref).toBe('feature/42-thing');
    expect(run.sha).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(run.created_at).toBe('2025-01-01T00:00:00Z');
    expect(run.finished_at).toBe('2025-01-01T00:05:00Z');

    // Verify selector was --branch, not --commit.
    const runListCall = execCalls.find((c) => c.includes('gh run list')) ?? '';
    expect(runListCall).toContain('--branch');
    expect(runListCall).not.toContain('--commit');
  });

  // --- GitHub: SHA ref ---
  test('github_sha_ref — 40-char hex ref uses --commit', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    execRegistry['git remote get-url origin'] =
      'https://github.com/org/repo.git';
    execRegistry['gh run list --commit'] = JSON.stringify([
      {
        databaseId: 7777,
        name: 'Build',
        status: 'in_progress',
        conclusion: null,
        url: 'https://github.com/org/repo/actions/runs/7777',
        headBranch: 'main',
        headSha: sha,
        createdAt: '2025-02-02T10:00:00Z',
        updatedAt: '2025-02-02T10:03:00Z',
      },
    ]);

    const result = await ciRunStatusHandler.execute({ ref: sha });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const run = data.data as Record<string, unknown>;
    expect(run.run_id).toBe(7777);
    expect(run.status).toBe('in_progress');
    expect(run.conclusion).toBeNull();
    // in_progress → finished_at null
    expect(run.finished_at).toBeNull();

    const runListCall = execCalls.find((c) => c.includes('gh run list')) ?? '';
    expect(runListCall).toContain('--commit');
    expect(runListCall).not.toContain('--branch');
  });

  // --- GitHub: workflow_name filter ---
  test('github_workflow_filter — passes --workflow flag to gh', async () => {
    execRegistry['git remote get-url origin'] =
      'https://github.com/org/repo.git';
    execRegistry['gh run list --branch'] = JSON.stringify([
      {
        databaseId: 999,
        name: 'Deploy',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/org/repo/actions/runs/999',
        headBranch: 'main',
        headSha: 'fedcba9876543210fedcba9876543210fedcba98',
        createdAt: '2025-03-03T00:00:00Z',
        updatedAt: '2025-03-03T00:02:00Z',
      },
    ]);

    const result = await ciRunStatusHandler.execute({
      ref: 'main',
      workflow_name: 'Deploy',
    });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect((data.data as Record<string, unknown>).workflow_name).toBe('Deploy');

    const runListCall = execCalls.find((c) => c.includes('gh run list')) ?? '';
    expect(runListCall).toContain('--workflow');
    expect(runListCall).toContain('Deploy');
  });

  // --- No runs found: structured error with code ---
  test('no_runs_found — returns structured error when list is empty', async () => {
    execRegistry['git remote get-url origin'] =
      'https://github.com/org/repo.git';
    execRegistry['gh run list --branch'] = JSON.stringify([]);

    const result = await ciRunStatusHandler.execute({ ref: 'branch-no-runs' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(data.code).toBe('no_runs_found');
    expect((data.error as string)).toContain('no CI runs found');
    expect((data.error as string)).toContain('branch-no-runs');
  });

  // --- No runs found with workflow filter mentions the filter ---
  test('no_runs_found_with_filter — error message includes workflow filter', async () => {
    execRegistry['git remote get-url origin'] =
      'https://github.com/org/repo.git';
    execRegistry['gh run list --branch'] = JSON.stringify([]);

    const result = await ciRunStatusHandler.execute({
      ref: 'main',
      workflow_name: 'Nightly',
    });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(data.code).toBe('no_runs_found');
    expect((data.error as string)).toContain("Nightly");
  });

  // --- GitLab: branch ref ---
  test('gitlab_branch_ref — queries pipelines by ref and normalizes status', async () => {
    execRegistry['git remote get-url origin'] =
      'https://gitlab.com/org/repo.git';
    execRegistry['glab api projects/org%2Frepo/pipelines?ref='] = JSON.stringify([
      {
        id: 555,
        status: 'success',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/555',
        ref: 'feature/5-gl',
        sha: 'aabbccddeeff0011223344556677889900aabbcc',
        created_at: '2025-04-04T12:00:00Z',
        updated_at: '2025-04-04T12:05:00Z',
        finished_at: '2025-04-04T12:05:00Z',
        source: 'push',
      },
    ]);

    const result = await ciRunStatusHandler.execute({ ref: 'feature/5-gl' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const run = data.data as Record<string, unknown>;
    expect(run.run_id).toBe(555);
    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('success');
    expect(run.url).toBe('https://gitlab.com/org/repo/-/pipelines/555');
    expect(run.ref).toBe('feature/5-gl');
  });

  // --- GitLab: SHA ref ---
  test('gitlab_sha_ref — 40-char hex uses --sha on glab', async () => {
    const sha = '11223344556677889900aabbccddeeff00112233';
    execRegistry['git remote get-url origin'] =
      'https://gitlab.com/org/repo.git';
    execRegistry['glab api projects/org%2Frepo/pipelines?ref='] = JSON.stringify([
      {
        id: 42,
        status: 'failed',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/42',
        ref: 'main',
        sha,
        created_at: '2025-05-05T00:00:00Z',
        updated_at: '2025-05-05T00:10:00Z',
        finished_at: '2025-05-05T00:10:00Z',
        name: null,
        source: 'merge_request_event',
      },
    ]);

    const result = await ciRunStatusHandler.execute({ ref: sha });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const run = data.data as Record<string, unknown>;
    expect(run.run_id).toBe(42);
    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('failure');
    expect(run.sha).toBe(sha);

  });

  // --- GitLab: workflow_name filters client-side ---
  test('gitlab_workflow_filter — filters pipelines by name client-side', async () => {
    execRegistry['git remote get-url origin'] =
      'https://gitlab.com/org/repo.git';
    // When workflow_name is provided, handler requests more records (limit 20)
    execRegistry['glab api projects/org%2Frepo/pipelines?ref=main&per_page=20'] = JSON.stringify([
      {
        id: 1,
        status: 'success',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/1',
        ref: 'main',
        sha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
        created_at: '2025-06-06T00:00:00Z',
        updated_at: '2025-06-06T00:01:00Z',
        finished_at: '2025-06-06T00:01:00Z',
        source: 'push',
      },
      {
        id: 2,
        status: 'success',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/2',
        ref: 'main',
        sha: 'bb22cc33dd44ee55ff66778899001122334455aa',
        created_at: '2025-06-06T00:02:00Z',
        updated_at: '2025-06-06T00:03:00Z',
        finished_at: '2025-06-06T00:03:00Z',
        source: 'schedule',
      },
    ]);

    const result = await ciRunStatusHandler.execute({
      ref: 'main',
      workflow_name: 'schedule',
    });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const run = data.data as Record<string, unknown>;
    expect(run.run_id).toBe(2);
    expect(run.workflow_name).toBe('schedule');
  });

  // --- GitLab: no runs matching filter yields structured error ---
  test('gitlab_no_runs — no matching pipeline returns no_runs_found error', async () => {
    execRegistry['git remote get-url origin'] =
      'https://gitlab.com/org/repo.git';
    // workflow_name provided, so uses per_page=20
    execRegistry['glab api projects/org%2Frepo/pipelines?ref=main&per_page=20'] = JSON.stringify([
      {
        id: 10,
        status: 'success',
        web_url: 'https://gitlab.com/org/repo/-/pipelines/10',
        ref: 'main',
        sha: 'cc33dd44ee55ff66778899001122334455aabbcc',
        created_at: '2025-07-07T00:00:00Z',
        updated_at: '2025-07-07T00:01:00Z',
        source: 'push',
      },
    ]);

    const result = await ciRunStatusHandler.execute({
      ref: 'main',
      workflow_name: 'release',
    });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(data.code).toBe('no_runs_found');
  });

  // --- Input validation: missing ref ---
  test('validation — missing ref returns error', async () => {
    const result = await ciRunStatusHandler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });

  // --- Issue #197: cross-repo orchestration via explicit `repo` ---

  test('github_explicit_repo — appends --repo flag to gh run list', async () => {
    execRegistry['git remote get-url origin'] =
      'https://github.com/cwd-org/cwd-repo.git';
    execRegistry['gh run list --branch'] = JSON.stringify([
      {
        databaseId: 9001,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/other-org/other-repo/actions/runs/9001',
        headBranch: 'main',
        headSha: '1111111111111111111111111111111111111111',
        createdAt: '2026-04-07T12:00:00Z',
        updatedAt: '2026-04-07T12:05:00Z',
      },
    ]);

    const result = await ciRunStatusHandler.execute({
      ref: 'main',
      repo: 'other-org/other-repo',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const runListCall = execCalls.find((c) => c.includes('gh run list')) ?? '';
    expect(runListCall).toContain('--repo');
    expect(runListCall).toContain('other-org/other-repo');
  });

  test('gitlab_explicit_repo — targets encoded explicit slug', async () => {
    execRegistry['git remote get-url origin'] =
      'https://gitlab.com/cwd-org/cwd-repo.git';
    execRegistry['glab api projects/other-org%2Fother-repo/pipelines?ref='] =
      JSON.stringify([
        {
          id: 9002,
          status: 'success',
          web_url: 'https://gitlab.com/other-org/other-repo/-/pipelines/9002',
          ref: 'main',
          sha: '2222222222222222222222222222222222222222',
          created_at: '2026-04-07T12:00:00Z',
          updated_at: '2026-04-07T12:05:00Z',
          finished_at: '2026-04-07T12:05:00Z',
          source: 'push',
        },
      ]);

    const result = await ciRunStatusHandler.execute({
      ref: 'main',
      repo: 'other-org/other-repo',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const glabCall = execCalls.find((c) => c.startsWith('glab api')) ?? '';
    expect(glabCall).toContain('projects/other-org%2Fother-repo/pipelines');
    expect(glabCall).not.toContain('projects/cwd-org%2Fcwd-repo/pipelines');
  });

  test('regression_no_repo — omits --repo and uses cwd slug when repo not set', async () => {
    execRegistry['git remote get-url origin'] =
      'https://github.com/org/repo.git';
    execRegistry['gh run list --branch'] = JSON.stringify([
      {
        databaseId: 4242,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/org/repo/actions/runs/4242',
        headBranch: 'main',
        headSha: 'abc0000000000000000000000000000000000000',
        createdAt: '2026-04-07T12:00:00Z',
        updatedAt: '2026-04-07T12:05:00Z',
      },
    ]);

    const result = await ciRunStatusHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const runListCall = execCalls.find((c) => c.includes('gh run list')) ?? '';
    expect(runListCall).not.toContain('--repo');
  });

  // --- Input validation: unsafe ref characters ---
  test('validation — shell-unsafe ref characters surface as error', async () => {
    execRegistry['git remote get-url origin'] =
      'https://github.com/org/repo.git';

    const result = await ciRunStatusHandler.execute({ ref: 'main; rm -rf /' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });
});
