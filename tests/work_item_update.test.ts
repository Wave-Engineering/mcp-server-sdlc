import { describe, test, expect, beforeEach } from 'bun:test';
import { installChildProcessMock, onExec, resetExecMock, execCalls } from '../lib/test-support/mock-child-process.ts';

// Integration coverage for the work_item_update handler (#287).
//
// Mirrors tests/work_item.test.ts: argv-shape assertions live in the colocated
// adapter tests; this file owns:
//   - schema validation
//   - handler envelope shape
//   - cross-platform dispatch via detect-platform
//   - dry-run preview path
//
// Per `lesson_origin_ops_pitfalls.md` the work-item-update adapters call
// runArgv which shell-escapes its argv. The unquote shim strips that quoting
// so test match-keys can stay as plain `gh issue edit` strings.

interface MockExecError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { default: handler } = await import('../handlers/work_item_update.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  resetExecMock();
});

describe('work_item_update handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('work_item_update');
    expect(typeof handler.execute).toBe('function');
  });

  // ---- schema validation ----

  test('schema rejects bad issue_ref', async () => {
    const result = await handler.execute({
      issue_ref: 'totally not a ref',
      patch: { title: 'x' },
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toMatch(/issue_ref/);
  });

  test('schema rejects empty patch object', async () => {
    const result = await handler.execute({ issue_ref: '#1', patch: {} });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toMatch(/patch/);
  });

  test('schema rejects body + body_section together', async () => {
    const result = await handler.execute({
      issue_ref: '#1',
      patch: { body: 'x', body_section: { heading: 'A', content: 'y' } },
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toMatch(/mutually exclusive/i);
  });

  // ---- github dispatch ----

  test('github — title patch dispatches to gh issue edit', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue edit', 'https://github.com/org/repo/issues/42\n');

    const result = await handler.execute({
      issue_ref: '#42',
      patch: { title: 'Renamed' },
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.dry_run).toBe(false);

    const call = execCalls().find((c) => unquote(c).includes('gh issue edit')) ?? '';
    expect(call).toContain("'--title' 'Renamed'");
  });

  test('github — body_section patch reads body, splices, sends full --body', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec(
      'gh issue view',
      JSON.stringify({
        number: 5,
        url: 'https://github.com/org/repo/issues/5',
        body: '## Summary\nx\n\n## Dependencies\n- old\n',
        labels: [],
        assignees: [],
      }),
    );
    onExec('gh issue edit', 'https://github.com/org/repo/issues/5\n');

    const result = await handler.execute({
      issue_ref: '#5',
      patch: { body_section: { heading: 'Dependencies', content: '- new' } },
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.resolved_body).toContain('- new');
    expect(data.resolved_body).not.toContain('- old');
    // AC: section patching preserves other H2 sections unmodified
    expect(data.resolved_body).toContain('## Summary');

    const editCall = execCalls().find((c) => unquote(c).includes('gh issue edit')) ?? '';
    expect(editCall).toContain('--body');
  });

  test('github — dry_run:true returns preview without invoking gh issue edit', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');

    const result = await handler.execute({
      issue_ref: '#42',
      patch: { title: 'Preview' },
      dry_run: true,
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.dry_run).toBe(true);
    expect(execCalls().find((c) => unquote(c).includes('gh issue edit'))).toBeUndefined();
  });

  // ---- gitlab dispatch ----

  test('gitlab — title patch dispatches to glab issue update', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab issue update', 'https://gitlab.com/org/repo/-/issues/42\n');

    const result = await handler.execute({
      issue_ref: '#42',
      patch: { title: 'Renamed' },
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);

    const call = execCalls().find((c) => unquote(c).includes('glab issue update')) ?? '';
    expect(call).toContain("'--title' 'Renamed'");
  });

  test('gitlab — milestone patch returns platform_unsupported', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');

    const result = await handler.execute({
      issue_ref: '#1',
      patch: { milestone: 'v1.0' },
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(data.platform_unsupported).toBe(true);
    expect(String(data.error).toLowerCase()).toContain('milestone');
  });

  // ---- error surface ----

  test('github — surfaces ok:false on subprocess failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue edit', () => {
      const err: MockExecError = new Error('not authenticated') as MockExecError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await handler.execute({
      issue_ref: '#1',
      patch: { title: 'x' },
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh issue edit failed');
  });
});
