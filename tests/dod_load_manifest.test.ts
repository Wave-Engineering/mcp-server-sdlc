import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock child_process for gh shell-outs.
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/dod_load_manifest.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const SAMPLE_PRD = `# Some PRD

Intro text.

## Deliverables Manifest

| ID | Description | Evidence Path | Status | Category |
|----|-------------|---------------|--------|----------|
| D-01 | Wave init handler | handlers/wave_init.ts | done | code |
| D-02 | Docs updated | docs/WAVE.md | pending | docs |

## Next Section

Out of scope for manifest parsing.
`;

async function writeTempFile(content: string): Promise<string> {
  const path = `/tmp/dod-manifest-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

describe('dod_load_manifest handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('dod_load_manifest');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses_valid_manifest — local file with well-formed table', async () => {
    const path = await writeTempFile(SAMPLE_PRD);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.deliverables.length).toBe(2);
    expect(parsed.deliverables[0]).toEqual({
      id: 'D-01',
      description: 'Wave init handler',
      evidence_path: 'handlers/wave_init.ts',
      status: 'done',
      category: 'code',
    });
    expect(parsed.deliverables[1].id).toBe('D-02');
  });

  test('handles_missing_manifest_section — PRD with no manifest returns error', async () => {
    const path = await writeTempFile('# PRD\n\nNo manifest here.\n');
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no Deliverables Manifest');
  });

  test('handles_malformed_rows — warns on short rows, continues parsing', async () => {
    const md = `## Deliverables Manifest

| ID | Description | Evidence Path | Status | Category |
|----|-------------|---------------|--------|----------|
| D-01 | Only has three cells |
| D-02 | Valid row | path/thing | done | code |
`;
    const path = await writeTempFile(md);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.deliverables.length).toBe(1);
    expect(parsed.deliverables[0].id).toBe('D-02');
  });

  test('reads_from_gh_issue — #N format shells out to gh issue view', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 42')) {
        return JSON.stringify({ body: SAMPLE_PRD });
      }
      return '';
    };
    const result = await handler.execute({ path: '#42' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.deliverables.length).toBe(2);
  });

  test('reads_from_gh_issue — org/repo#N format uses --repo flag', async () => {
    let seenCmd = '';
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view')) {
        seenCmd = cmd;
        return JSON.stringify({ body: SAMPLE_PRD });
      }
      return '';
    };
    const result = await handler.execute({ path: 'acme/widgets#7' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(seenCmd).toContain('--repo acme/widgets');
    expect(seenCmd).toContain('7');
  });

  test('missing_file_returns_structured_error', async () => {
    const result = await handler.execute({ path: '/tmp/nonexistent-prd-file-xyz.md' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
  });

  test('schema_validation — rejects missing path', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects empty path', async () => {
    const result = await handler.execute({ path: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
