import { describe, test, expect, mock, beforeEach } from 'bun:test';

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

const { default: handler } = await import('../handlers/label_list.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = {};
  execCalls = [];
  execError = null;
});

describe('label_list handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('label_list');
    expect(typeof handler.execute).toBe('function');
  });

  test('github — returns normalized labels from gh label list', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh label list'] = JSON.stringify([
      { name: 'bug', description: 'Something broken', color: 'd73a4a' },
      { name: 'enhancement', description: 'New feature', color: 'a2eeef' },
    ]);
    const result = await handler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.count).toBe(2);
    const labels = data.labels as Array<{ name: string; color: string }>;
    expect(labels[0].name).toBe('bug');
    expect(labels[0].color).toBe('d73a4a');
  });

  test('github — passes --limit and --repo flags', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh label list'] = '[]';
    await handler.execute({ limit: 50, repo: 'foo/bar' });
    const ghCall = execCalls.find((c) => c.includes('gh label list')) ?? '';
    expect(ghCall).toContain('--limit 50');
    expect(ghCall).toContain("--repo 'foo/bar'");
    expect(ghCall).toContain('--json name,description,color');
  });

  test('gitlab — returns normalized labels from glab label list, strips leading # from color', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab label list'] = JSON.stringify([
      { name: 'bug', description: 'Bug', color: '#d73a4a' },
      { name: 'enhancement', color: '#a2eeef' }, // no description
    ]);
    const result = await handler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const labels = data.labels as Array<{ name: string; color: string; description: string }>;
    expect(labels[0].color).toBe('d73a4a'); // # stripped
    expect(labels[1].color).toBe('a2eeef');
    expect(labels[1].description).toBe(''); // missing → empty string
  });

  test('gitlab — passes --per-page and -R flags', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab label list'] = '[]';
    await handler.execute({ limit: 25, repo: 'foo/bar' });
    const glabCall = execCalls.find((c) => c.includes('glab label list')) ?? '';
    expect(glabCall).toContain('--per-page 25');
    expect(glabCall).toContain("-R 'foo/bar'");
    expect(glabCall).toContain('-F json');
  });

  test('returns ok:false on subprocess failure', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execError = new Error('gh not authenticated');
    const result = await handler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh not authenticated');
  });

  test('default limit is 100 when not specified', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh label list'] = '[]';
    await handler.execute({});
    const ghCall = execCalls.find((c) => c.includes('gh label list')) ?? '';
    expect(ghCall).toContain('--limit 100');
  });

  test('schema rejects malformed repo', async () => {
    const result = await handler.execute({ repo: 'not-a-slug' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('owner/repo');
  });
});
