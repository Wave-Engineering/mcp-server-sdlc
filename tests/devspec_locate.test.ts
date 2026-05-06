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

const { default: handler } = await import('../handlers/devspec_locate.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Build a fake execSync that recognizes the handler's command shapes:
 *   1. `test -d '<root>'`                     — root existence
 *   2. `test -d '<root>/docs'`                — docs existence
 *   3. `test -d '<root>/Docs'`                — Docs existence
 *   4. `test -d '<root>/docs/devspecs'`       — docs/devspecs existence
 *   5. `test -d '<root>/Docs/devspecs'`       — Docs/devspecs existence
 *   6. `find <path> -maxdepth 1 ...`          — list devspec files
 *
 * Callers configure which directories "exist" and what each find output is.
 */
function buildExec(opts: {
  rootExists: boolean;
  docsExists?: boolean;
  DocsExists?: boolean;
  docsDevspecsExists?: boolean;
  DocsDevspecsExists?: boolean;
  findOutputs?: Record<string, string>;
}) {
  return (cmd: string) => {
    if (cmd.startsWith('test -d')) {
      // Check for each possible path
      if (/\/Docs\/devspecs'?$/.test(cmd)) {
        if (!opts.DocsDevspecsExists) throw new Error('Docs/devspecs missing');
        return '';
      }
      if (/\/docs\/devspecs'?$/.test(cmd)) {
        if (!opts.docsDevspecsExists) throw new Error('docs/devspecs missing');
        return '';
      }
      if (/\/Docs'?$/.test(cmd)) {
        if (!opts.DocsExists) throw new Error('Docs missing');
        return '';
      }
      if (/\/docs'?$/.test(cmd)) {
        if (!opts.docsExists) throw new Error('docs missing');
        return '';
      }
      if (!opts.rootExists) throw new Error('root missing');
      return '';
    }
    if (cmd.startsWith('find ')) {
      // Extract the path being searched (docs, Docs, docs/devspecs, or Docs/devspecs)
      const match = cmd.match(/^find '([^']+)'/);
      if (match && opts.findOutputs && match[1] in opts.findOutputs) {
        return opts.findOutputs[match[1]];
      }
      return '';
    }
    return '';
  };
}

describe('devspec_locate handler', () => {
  beforeEach(() => {
    resetMocks();
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    resetMocks();
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('devspec_locate');
    expect(typeof handler.execute).toBe('function');
  });

  test('finds single devspec file in lowercase docs/', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutputs: { docs: 'docs/alpha-devspec.md\n' },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['docs/alpha-devspec.md']);
    expect(parsed.count).toBe(1);
  });

  test('finds and sorts multiple devspec files in lowercase docs/', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      // Deliberately unsorted to prove the handler sorts.
      findOutputs: { docs: 'docs/charlie-devspec.md\ndocs/alpha-devspec.md\ndocs/bravo-devspec.md\n' },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([
      'docs/alpha-devspec.md',
      'docs/bravo-devspec.md',
      'docs/charlie-devspec.md',
    ]);
    expect(parsed.count).toBe(3);
  });

  test('finds devspec file in capital Docs/', async () => {
    execMockFn = buildExec({
      rootExists: true,
      DocsExists: true,
      findOutputs: { Docs: 'Docs/init-devspec.md\n' },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['Docs/init-devspec.md']);
    expect(parsed.count).toBe(1);
  });

  test('finds devspec file in docs/devspecs/ subdirectory', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsDevspecsExists: true,
      findOutputs: { 'docs/devspecs': 'docs/devspecs/feature-devspec.md\n' },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['docs/devspecs/feature-devspec.md']);
    expect(parsed.count).toBe(1);
  });

  test('finds devspec file in Docs/devspecs/ subdirectory', async () => {
    execMockFn = buildExec({
      rootExists: true,
      DocsDevspecsExists: true,
      findOutputs: { 'Docs/devspecs': 'Docs/devspecs/init-devspec.md\n' },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['Docs/devspecs/init-devspec.md']);
    expect(parsed.count).toBe(1);
  });

  test('returns union of files from multiple conventional locations', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      DocsExists: true,
      docsDevspecsExists: true,
      DocsDevspecsExists: true,
      findOutputs: {
        docs: 'docs/legacy-devspec.md\n',
        Docs: 'Docs/newer-devspec.md\n',
        'docs/devspecs': 'docs/devspecs/feature-devspec.md\n',
        'Docs/devspecs': 'Docs/devspecs/init-devspec.md\n',
      },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([
      'Docs/devspecs/init-devspec.md',
      'Docs/newer-devspec.md',
      'docs/devspecs/feature-devspec.md',
      'docs/legacy-devspec.md',
    ]);
    expect(parsed.count).toBe(4);
  });

  test('returns empty list when none exist', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutputs: { docs: '' },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  test('handles missing docs/ directory — not an error', async () => {
    execMockFn = buildExec({
      rootExists: true,
      // None of the conventional directories exist
      docsExists: false,
      DocsExists: false,
      docsDevspecsExists: false,
      DocsDevspecsExists: false,
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([]);
    expect(parsed.count).toBe(0);
    // find should NOT have been called when no directories exist.
    const findCalls = execCalls.filter(c => c.cmd.startsWith('find '));
    expect(findCalls.length).toBe(0);
  });

  test('errors on nonexistent root', async () => {
    execMockFn = buildExec({
      rootExists: false,
    });
    const result = await handler.execute({ root: '/tmp/nonexistent' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('/tmp/nonexistent');
  });

  test('uses CLAUDE_PROJECT_DIR when root param omitted', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/env-root';
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutputs: { docs: 'docs/env-devspec.md\n' },
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['docs/env-devspec.md']);
    // find should have been invoked with cwd=/tmp/env-root
    const findCall = execCalls.find(c => c.cmd.startsWith('find '));
    expect(findCall?.opts?.cwd).toBe('/tmp/env-root');
  });

  test('explicit root param takes precedence over CLAUDE_PROJECT_DIR', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/env-root';
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutputs: { docs: 'docs/explicit-devspec.md\n' },
    });
    await handler.execute({ root: '/tmp/explicit' });
    const findCall = execCalls.find(c => c.cmd.startsWith('find '));
    expect(findCall?.opts?.cwd).toBe('/tmp/explicit');
  });

  test('find is invoked with correct glob pattern', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutputs: { docs: '' },
    });
    await handler.execute({ root: '/tmp/proj' });
    const findCall = execCalls.find(c => c.cmd.startsWith('find '));
    expect(findCall?.cmd).toContain('-maxdepth 1');
    expect(findCall?.cmd).toContain(`-name '*-devspec.md'`);
  });

  test('backward compatibility — legacy lowercase docs/ flat layout still works', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutputs: { docs: 'docs/init-devspec.md\ndocs/feature-devspec.md\n' },
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toContain('docs/init-devspec.md');
    expect(parsed.files).toContain('docs/feature-devspec.md');
    expect(parsed.count).toBe(2);
  });
});
