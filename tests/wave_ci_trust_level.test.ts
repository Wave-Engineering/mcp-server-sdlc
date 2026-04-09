import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const handlerModule = await import('../handlers/wave_ci_trust_level.ts');
const handler = handlerModule.default;
const resetCache = handlerModule.__resetCache;

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
  resetCache();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_ci_trust_level handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_ci_trust_level');
    expect(typeof handler.execute).toBe('function');
  });

  test('github_merge_queue_enabled — pre_merge_authoritative', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git rev-parse')) return '/tmp/repo\n';
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([{ id: 1, enforcement: 'active' }]);
      }
      if (cmd.includes('rulesets/1')) {
        return JSON.stringify({ rules: [{ type: 'merge_queue' }] });
      }
      return '{}';
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.level).toBe('pre_merge_authoritative');
    expect(parsed.reason).toContain('merge queue');
  });

  test('github_strict_protection_only — pre_merge_authoritative', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git rev-parse')) return '/tmp/repo2\n';
      if (cmd.startsWith('git remote')) return 'git@github.com:org/repo.git\n';
      if (cmd.includes('rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([]);
      }
      if (cmd.includes('branches/main/protection')) {
        return JSON.stringify({ required_status_checks: { strict: true } });
      }
      return '{}';
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.level).toBe('pre_merge_authoritative');
    expect(parsed.reason).toContain('strict');
  });

  test('github_no_strict — post_merge_required', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git rev-parse')) return '/tmp/repo3\n';
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([]);
      }
      if (cmd.includes('branches/main/protection')) {
        return JSON.stringify({ required_status_checks: { strict: false } });
      }
      return '{}';
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.level).toBe('post_merge_required');
  });

  test('gitlab_trains_enabled — pre_merge_authoritative', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git rev-parse')) return '/tmp/repo4\n';
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/org/repo.git\n';
      if (cmd.includes('glab api projects/org%2Frepo')) {
        return JSON.stringify({
          id: 123,
          name: 'repo',
          path: 'repo',
          path_with_namespace: 'org/repo',
          web_url: 'https://gitlab.com/org/repo',
          merge_pipelines_enabled: true,
          merge_trains_enabled: true,
        });
      }
      return '{}';
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.level).toBe('pre_merge_authoritative');
  });

  test('gitlab_pipelines_only — post_merge_required', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git rev-parse')) return '/tmp/repo5\n';
      if (cmd.startsWith('git remote')) return 'https://gitlab.com/org/repo.git\n';
      if (cmd.includes('glab api projects/org%2Frepo')) {
        return JSON.stringify({
          id: 123,
          name: 'repo',
          path: 'repo',
          path_with_namespace: 'org/repo',
          web_url: 'https://gitlab.com/org/repo',
          merge_pipelines_enabled: true,
          merge_trains_enabled: false,
        });
      }
      return '{}';
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.level).toBe('post_merge_required');
  });

  test('api_failure_returns_unknown', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git rev-parse')) return '/tmp/repo6\n';
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      throw new Error('gh api: not authenticated');
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.level).toBe('unknown');
  });

  test('caches_result_per_project', async () => {
    let ghCallCount = 0;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git rev-parse')) return '/tmp/repo7\n';
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('rulesets') && !cmd.match(/rulesets\/\d+/)) {
        ghCallCount++;
        return JSON.stringify([{ id: 1, enforcement: 'active' }]);
      }
      if (cmd.includes('rulesets/1')) {
        ghCallCount++;
        return JSON.stringify({ rules: [{ type: 'merge_queue' }] });
      }
      return '{}';
    };
    await handler.execute({});
    const firstCount = ghCallCount;
    await handler.execute({});
    // Second call should hit cache, not increment count further.
    expect(ghCallCount).toBe(firstCount);
  });

  test('schema_validation — rejects unknown fields', async () => {
    const result = await handler.execute({ foo: 'bar' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
