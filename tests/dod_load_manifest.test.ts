import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock child_process registry — matched by substring so individual tests can
// install exec fixtures for `git remote`, `gh issue view`, `glab api projects/...`.
// The handler now dispatches through getAdapter().fetchIssue(...), which under
// the hood still execs `gh issue view` (GitHub) / `glab api projects/...`
// (GitLab); tests exercise the real adapter stack with only subprocess mocked.
let execRegistry: Record<string, string> = {};

function mockExec(cmd: string): string {
  for (const [key, value] of Object.entries(execRegistry)) {
    if (cmd.includes(key)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

const mockExecSync = mock((cmd: string, _opts?: unknown) => mockExec(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/dod_load_manifest.ts');

function resetMocks() {
  execRegistry = {};
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

  test('reads_from_gh_issue — #N format shells out via adapter', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git\n';
    execRegistry['gh issue view 42'] = JSON.stringify({
      number: 42,
      title: 'PRD',
      state: 'OPEN',
      url: 'https://github.com/org/repo/issues/42',
      body: SAMPLE_PRD,
      labels: [],
    });
    const result = await handler.execute({ path: '#42' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.deliverables.length).toBe(2);
  });

  test('reads_from_gh_issue — org/repo#N format uses --repo flag (GitHub)', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git\n';
    execRegistry['gh issue view 7 --json'] = JSON.stringify({
      number: 7,
      title: 'PRD',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/issues/7',
      body: SAMPLE_PRD,
      labels: [],
    });
    const result = await handler.execute({ path: 'acme/widgets#7' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    // Verify the adapter dispatched to the cross-repo slug.
    const sawRepoFlag = mockExecSync.mock.calls.some(call => {
      const cmd = call[0] as string;
      return cmd.includes('gh issue view 7') && cmd.includes('--repo acme/widgets');
    });
    expect(sawRepoFlag).toBe(true);
  });

  // Regression for #283 — cross-repo ISSUE_REF on GitLab silently broke
  // before Story 2.7. The migration moves dispatch to getAdapter().fetchIssue
  // so the `org/project#N` branch resolves on BOTH platforms.
  test('reads_from_gitlab_issue — org/repo#N resolves on GitLab (regression for #283)', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/mygroup/myrepo.git\n';
    execRegistry['glab api projects/acme%2Fwidgets/issues/7'] = JSON.stringify({
      iid: 7,
      title: 'PRD',
      state: 'opened',
      web_url: 'https://gitlab.com/acme/widgets/-/issues/7',
      description: SAMPLE_PRD,
      labels: [],
    });
    const result = await handler.execute({ path: 'acme/widgets#7' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.deliverables.length).toBe(2);
    // Verify the adapter dispatched to the cross-repo project path, not the
    // cwd repo slug — this is the exact gap #283 covers.
    const sawCrossRepoCall = mockExecSync.mock.calls.some(call => {
      const cmd = call[0] as string;
      return cmd.includes('glab api projects/acme%2Fwidgets/issues/7');
    });
    expect(sawCrossRepoCall).toBe(true);
  });

  test('reads_from_gitlab_issue — bare #N uses cwd project path', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/mygroup/myrepo.git\n';
    execRegistry['glab api projects/mygroup%2Fmyrepo/issues/42'] = JSON.stringify({
      iid: 42,
      title: 'PRD',
      state: 'opened',
      web_url: 'https://gitlab.com/mygroup/myrepo/-/issues/42',
      description: SAMPLE_PRD,
      labels: [],
    });
    const result = await handler.execute({ path: '#42' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.deliverables.length).toBe(2);
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
