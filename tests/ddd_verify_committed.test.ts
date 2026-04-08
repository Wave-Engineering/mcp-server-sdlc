import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

interface ExecCall {
  cmd: string;
  opts: { cwd?: string; encoding?: string } | undefined;
}

let execCalls: ExecCall[] = [];
let execMockFn: (cmd: string, opts?: { cwd?: string }) => string = () => '';
const mockExecSync = mock((cmd: string, opts?: { cwd?: string; encoding?: string }) => {
  execCalls.push({ cmd, opts });
  return execMockFn(cmd, opts);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/ddd_verify_committed.ts');

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Build a mock that handles:
 *   - `test -e <path>` for file existence
 *   - `git status --porcelain -- <path>` returning the configured status output
 */
function buildExec(opts: { fileExists: boolean; gitStatus: string; gitThrows?: boolean }) {
  return (cmd: string) => {
    if (cmd.startsWith('test -e')) {
      if (!opts.fileExists) throw new Error('file missing');
      return '';
    }
    if (cmd.startsWith('git status')) {
      if (opts.gitThrows) throw new Error('fatal: not a git repository');
      return opts.gitStatus;
    }
    return '';
  };
}

describe('ddd_verify_committed handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('ddd_verify_committed');
    expect(typeof handler.execute).toBe('function');
  });

  test('returns committed:true when file is clean', async () => {
    execMockFn = buildExec({ fileExists: true, gitStatus: '' });
    const result = await handler.execute({ path: '/tmp/repo/docs/DOMAIN-MODEL.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(true);
    expect(parsed.path).toBe('/tmp/repo/docs/DOMAIN-MODEL.md');
    expect(parsed.status).toBeUndefined();
  });

  test('returns committed:false with status for modified file', async () => {
    execMockFn = buildExec({
      fileExists: true,
      gitStatus: ' M docs/DOMAIN-MODEL.md\n',
    });
    const result = await handler.execute({ path: '/tmp/repo/docs/DOMAIN-MODEL.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(false);
    expect(parsed.status).toBe(' M docs/DOMAIN-MODEL.md');
  });

  test('returns committed:false for untracked file', async () => {
    execMockFn = buildExec({
      fileExists: true,
      gitStatus: '?? docs/DOMAIN-MODEL.md\n',
    });
    const result = await handler.execute({ path: '/tmp/repo/docs/DOMAIN-MODEL.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.committed).toBe(false);
    expect(parsed.status).toBe('?? docs/DOMAIN-MODEL.md');
  });

  test('returns error when file does not exist', async () => {
    execMockFn = buildExec({ fileExists: false, gitStatus: '' });
    const result = await handler.execute({ path: '/tmp/nonexistent.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
  });

  test('returns error when git status fails (not a git repo)', async () => {
    execMockFn = buildExec({ fileExists: true, gitStatus: '', gitThrows: true });
    const result = await handler.execute({ path: '/tmp/not-a-repo/file.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('git status failed');
  });

  test('git status invoked with cwd set to containing directory', async () => {
    execMockFn = buildExec({ fileExists: true, gitStatus: '' });
    await handler.execute({ path: '/tmp/repo/subdir/FILE.md' });
    const gitCall = execCalls.find(c => c.cmd.startsWith('git status'));
    expect(gitCall).toBeDefined();
    expect(gitCall?.opts?.cwd).toBe('/tmp/repo/subdir');
  });

  test('schema rejects missing path', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema rejects empty path', async () => {
    const result = await handler.execute({ path: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
