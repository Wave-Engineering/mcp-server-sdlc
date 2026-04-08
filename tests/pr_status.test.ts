import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
// Registry-based mock so individual tests can register expected calls.

let execRegistry: Array<{ match: string; value: string }> = [];
let execError: Error | null = null;

function mockExec(cmd: string): string {
  if (execError) throw execError;
  for (const { match, value } of execRegistry) {
    if (cmd.includes(match)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// Import AFTER the mock is registered
const { default: prStatusHandler } = await import('../handlers/pr_status.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function register(match: string, value: string) {
  execRegistry.push({ match, value });
}

function registerGithubRemote() {
  register('git remote get-url origin', 'https://github.com/Wave-Engineering/example.git');
}

function registerGitlabRemote() {
  register('git remote get-url origin', 'https://gitlab.com/group/example.git');
}

beforeEach(() => {
  execRegistry = [];
  execError = null;
});

describe('pr_status handler', () => {
  // --- input validation ---
  test('invalid_input — missing number returns error', async () => {
    const result = await prStatusHandler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });

  test('invalid_input — non-positive number returns error', async () => {
    const result = await prStatusHandler.execute({ number: 0 });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });

  test('invalid_input — non-integer number returns error', async () => {
    const result = await prStatusHandler.execute({ number: 1.5 });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });

  // --- GitHub paths ---

  test('github_open_clean_all_checks_passed', async () => {
    registerGithubRemote();
    register(
      'gh pr view 42 --json',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/Wave-Engineering/example/pull/42',
      }),
    );
    register(
      'gh pr checks 42',
      JSON.stringify([
        { name: 'validate', state: 'completed', conclusion: 'success' },
        { name: 'lint', state: 'completed', conclusion: 'success' },
      ]),
    );

    const result = await prStatusHandler.execute({ number: 42 });
    const out = parseResult(result.content);
    expect(out.ok).toBe(true);
    const data = out.data as Record<string, unknown>;
    expect(data.number).toBe(42);
    expect(data.state).toBe('open');
    expect(data.merge_state).toBe('clean');
    expect(data.mergeable).toBe(true);
    const checks = data.checks as Record<string, unknown>;
    expect(checks.total).toBe(2);
    expect(checks.passed).toBe(2);
    expect(checks.failed).toBe(0);
    expect(checks.pending).toBe(0);
    expect(checks.summary).toBe('all_passed');
    expect(data.url).toBe('https://github.com/Wave-Engineering/example/pull/42');
  });

  test('github_open_unstable_has_failures', async () => {
    registerGithubRemote();
    register(
      'gh pr view 100 --json',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'UNSTABLE',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/Wave-Engineering/example/pull/100',
      }),
    );
    register(
      'gh pr checks 100',
      JSON.stringify([
        { name: 'validate', state: 'completed', conclusion: 'success' },
        { name: 'flaky-test', state: 'completed', conclusion: 'failure' },
      ]),
    );

    const result = await prStatusHandler.execute({ number: 100 });
    const out = parseResult(result.content);
    expect(out.ok).toBe(true);
    const data = out.data as Record<string, unknown>;
    expect(data.merge_state).toBe('unstable');
    const checks = data.checks as Record<string, unknown>;
    expect(checks.total).toBe(2);
    expect(checks.passed).toBe(1);
    expect(checks.failed).toBe(1);
    expect(checks.summary).toBe('has_failures');
  });

  test('github_open_pending_checks', async () => {
    registerGithubRemote();
    register(
      'gh pr view 7 --json',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'BLOCKED',
        mergeable: 'UNKNOWN',
        url: 'https://github.com/Wave-Engineering/example/pull/7',
      }),
    );
    register(
      'gh pr checks 7',
      JSON.stringify([
        { name: 'validate', state: 'in_progress', conclusion: null },
        { name: 'lint', state: 'completed', conclusion: 'success' },
      ]),
    );

    const result = await prStatusHandler.execute({ number: 7 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.merge_state).toBe('blocked');
    expect(data.mergeable).toBe(false);
    const checks = data.checks as Record<string, unknown>;
    expect(checks.passed).toBe(1);
    expect(checks.pending).toBe(1);
    expect(checks.summary).toBe('pending');
  });

  test('github_merged', async () => {
    registerGithubRemote();
    register(
      'gh pr view 11 --json',
      JSON.stringify({
        state: 'MERGED',
        mergeStateStatus: '',
        mergeable: 'UNKNOWN',
        url: 'https://github.com/Wave-Engineering/example/pull/11',
      }),
    );
    register('gh pr checks 11', JSON.stringify([]));

    const result = await prStatusHandler.execute({ number: 11 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.state).toBe('merged');
    const checks = data.checks as Record<string, unknown>;
    expect(checks.total).toBe(0);
    expect(checks.summary).toBe('none');
  });

  test('github_closed', async () => {
    registerGithubRemote();
    register(
      'gh pr view 22 --json',
      JSON.stringify({
        state: 'CLOSED',
        mergeStateStatus: 'DIRTY',
        mergeable: 'CONFLICTING',
        url: 'https://github.com/Wave-Engineering/example/pull/22',
      }),
    );
    register('gh pr checks 22', JSON.stringify([]));

    const result = await prStatusHandler.execute({ number: 22 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.state).toBe('closed');
    expect(data.merge_state).toBe('dirty');
    expect(data.mergeable).toBe(false);
  });

  test('github_no_checks_command_failure_treated_as_none', async () => {
    registerGithubRemote();
    register(
      'gh pr view 99 --json',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/Wave-Engineering/example/pull/99',
      }),
    );
    // Intentionally do NOT register gh pr checks — the handler should catch and treat as 'none'

    const result = await prStatusHandler.execute({ number: 99 });
    const out = parseResult(result.content);
    expect(out.ok).toBe(true);
    const data = out.data as Record<string, unknown>;
    expect(data.merge_state).toBe('clean');
    const checks = data.checks as Record<string, unknown>;
    expect(checks.total).toBe(0);
    expect(checks.summary).toBe('none');
  });

  // --- GitLab paths ---

  test('gitlab_open_clean_pipeline_success', async () => {
    registerGitlabRemote();
    register(
      'glab mr view 5 --output json',
      JSON.stringify({
        iid: 5,
        state: 'opened',
        detailed_merge_status: 'mergeable',
        merge_status: 'can_be_merged',
        web_url: 'https://gitlab.com/group/example/-/merge_requests/5',
        head_pipeline: { status: 'success' },
      }),
    );

    const result = await prStatusHandler.execute({ number: 5 });
    const out = parseResult(result.content);
    expect(out.ok).toBe(true);
    const data = out.data as Record<string, unknown>;
    expect(data.state).toBe('open');
    expect(data.merge_state).toBe('clean');
    expect(data.mergeable).toBe(true);
    const checks = data.checks as Record<string, unknown>;
    expect(checks.total).toBe(1);
    expect(checks.passed).toBe(1);
    expect(checks.summary).toBe('all_passed');
    expect(data.url).toBe('https://gitlab.com/group/example/-/merge_requests/5');
  });

  test('gitlab_open_failed_pipeline', async () => {
    registerGitlabRemote();
    register(
      'glab mr view 6 --output json',
      JSON.stringify({
        iid: 6,
        state: 'opened',
        detailed_merge_status: 'ci_must_pass',
        merge_status: 'cannot_be_merged',
        web_url: 'https://gitlab.com/group/example/-/merge_requests/6',
        head_pipeline: { status: 'failed' },
      }),
    );

    const result = await prStatusHandler.execute({ number: 6 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.merge_state).toBe('blocked');
    const checks = data.checks as Record<string, unknown>;
    expect(checks.failed).toBe(1);
    expect(checks.summary).toBe('has_failures');
  });

  test('gitlab_open_pending_pipeline', async () => {
    registerGitlabRemote();
    register(
      'glab mr view 8 --output json',
      JSON.stringify({
        iid: 8,
        state: 'opened',
        detailed_merge_status: 'ci_still_running',
        merge_status: 'unchecked',
        web_url: 'https://gitlab.com/group/example/-/merge_requests/8',
        pipeline: { status: 'running' },
      }),
    );

    const result = await prStatusHandler.execute({ number: 8 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.merge_state).toBe('unknown');
    const checks = data.checks as Record<string, unknown>;
    expect(checks.pending).toBe(1);
    expect(checks.summary).toBe('pending');
  });

  test('gitlab_merged', async () => {
    registerGitlabRemote();
    register(
      'glab mr view 12 --output json',
      JSON.stringify({
        iid: 12,
        state: 'merged',
        detailed_merge_status: 'mergeable',
        merge_status: 'can_be_merged',
        web_url: 'https://gitlab.com/group/example/-/merge_requests/12',
        head_pipeline: null,
      }),
    );

    const result = await prStatusHandler.execute({ number: 12 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.state).toBe('merged');
    const checks = data.checks as Record<string, unknown>;
    expect(checks.total).toBe(0);
    expect(checks.summary).toBe('none');
  });

  test('gitlab_closed', async () => {
    registerGitlabRemote();
    register(
      'glab mr view 33 --output json',
      JSON.stringify({
        iid: 33,
        state: 'closed',
        detailed_merge_status: 'conflict',
        merge_status: 'cannot_be_merged',
        web_url: 'https://gitlab.com/group/example/-/merge_requests/33',
      }),
    );

    const result = await prStatusHandler.execute({ number: 33 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.state).toBe('closed');
    expect(data.merge_state).toBe('dirty');
    expect(data.mergeable).toBe(false);
  });

  test('gitlab_legacy_merge_status_fallback', async () => {
    registerGitlabRemote();
    register(
      'glab mr view 44 --output json',
      JSON.stringify({
        iid: 44,
        state: 'opened',
        // No detailed_merge_status — old GitLab API
        merge_status: 'can_be_merged',
        web_url: 'https://gitlab.com/group/example/-/merge_requests/44',
      }),
    );

    const result = await prStatusHandler.execute({ number: 44 });
    const out = parseResult(result.content);
    const data = out.data as Record<string, unknown>;
    expect(data.merge_state).toBe('clean');
    expect(data.mergeable).toBe(true);
  });

  // --- Error path ---

  test('exec_failure_surfaces_as_ok_false', async () => {
    registerGithubRemote();
    execError = new Error('command failed: gh: not found');

    const result = await prStatusHandler.execute({ number: 1 });
    const out = parseResult(result.content);
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe('string');
  });
});
