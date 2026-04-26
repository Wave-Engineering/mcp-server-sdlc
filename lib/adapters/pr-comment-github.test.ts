import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrCommentResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub pr_comment adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope, schema
// validation) stays in tests/pr_comment.test.ts; this file owns the argv-shape
// and response-parsing assertions that prove the adapter speaks `gh` correctly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { prCommentGithub } = await import('./pr-comment-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<PrCommentResponse>,
): asserts r is { ok: true; data: PrCommentResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrCommentResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('prCommentGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    on(
      'gh pr comment',
      'https://github.com/org/repo/pull/42#issuecomment-1001\n',
    );

    const result = await prCommentGithub({ number: 42, body: 'looks good' });
    expectOk(result);
    expect(result.data.comment_id).toBe(1001);
    expect(result.data.number).toBe(42);
    expect(result.data.url).toBe('https://github.com/org/repo/pull/42#issuecomment-1001');

    const ghCall = findCall('gh pr comment');
    expect(ghCall).toContain('gh');
    expect(ghCall).toContain('pr');
    expect(ghCall).toContain('comment');
    expect(ghCall).toContain('42');
    expect(ghCall).toContain('--body');
    expect(ghCall).toContain('looks good');
    // No --repo flag when args.repo is omitted.
    expect(ghCall).not.toContain("'--repo'");
  });

  test('multi-line markdown body is preserved verbatim through shell-escape', async () => {
    on(
      'gh pr comment',
      'https://github.com/org/repo/pull/7#issuecomment-2002\n',
    );

    const body = [
      '**heads up** — see [issue](https://example.com/x)',
      '',
      '```ts',
      'const x: number = 1;',
      'console.log(`hello ${x}`);',
      '```',
      '',
      '- item one',
      '- item two',
    ].join('\n');

    const result = await prCommentGithub({ number: 7, body });
    expectOk(result);
    expect(result.data.comment_id).toBe(2002);

    // Body survives shell-escaping: assert each non-trivial line is present
    // verbatim in the unquoted command. Newlines inside single-quoted shell
    // strings are preserved literally — no escaping needed.
    const ghCall = findCall('gh pr comment');
    const flat = unquote(ghCall);
    expect(flat).toContain('**heads up**');
    expect(flat).toContain('[issue](https://example.com/x)');
    expect(flat).toContain('```ts');
    expect(flat).toContain('const x: number = 1;');
    expect(flat).toContain('console.log(`hello ${x}`);');
    expect(flat).toContain('- item one');
    expect(flat).toContain('- item two');
  });

  test('parses comment_id from #issuecomment-<id> URL fragment', async () => {
    on(
      'gh pr comment',
      'https://github.com/org/repo/pull/3#issuecomment-3003\n',
    );

    const result = await prCommentGithub({ number: 3, body: 'hi' });
    expectOk(result);
    expect(result.data.comment_id).toBe(3003);
    expect(result.data.url).toBe('https://github.com/org/repo/pull/3#issuecomment-3003');
  });

  test('returns AdapterResult{ok:false, code} on gh failure (not thrown)', async () => {
    on('gh pr comment', () => {
      const err = new Error('HTTP 404: Not Found') as ThrowableError;
      err.stderr = 'HTTP 404: Not Found';
      err.status = 1;
      throw err;
    });

    const result = await prCommentGithub({ number: 9999, body: 'nope' });
    expectErr(result);
    expect(result.code).toBe('gh_pr_comment_failed');
    expect(result.error).toContain('gh pr comment failed');
    expect(result.error).toContain('HTTP 404');
  });

  test('returns parse-failure code when stdout lacks #issuecomment-<id>', async () => {
    on('gh pr comment', 'posted comment ok\n');

    const result = await prCommentGithub({ number: 1, body: 'x' });
    expectErr(result);
    expect(result.code).toBe('gh_comment_id_parse_failed');
    expect(result.error).toContain('failed to parse comment ID');
  });

  test('--repo flag forwarded when args.repo provided', async () => {
    on(
      'gh pr comment',
      'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/42#issuecomment-1001\n',
    );

    await prCommentGithub({
      number: 42,
      body: 'cross-repo',
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });

    const ghCall = findCall('gh pr comment');
    expect(ghCall).toContain('--repo');
    expect(ghCall).toContain('Wave-Engineering/mcp-server-sdlc');
  });
});
