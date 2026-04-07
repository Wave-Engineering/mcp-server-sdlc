import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Uses Bun.file / Bun.write exclusively — no module mocks.

const { default: handler } = await import('../handlers/dod_check_coverage.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

async function tempFile(name: string, content: string): Promise<string> {
  fixtureDir = `/tmp/dod-coverage-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const path = `${fixtureDir}/${name}`;
  await Bun.write(path, content);
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
  return path;
}

const COBERTURA_XML = `<?xml version="1.0" ?>
<coverage line-rate="0.85" branch-rate="0.80">
  <packages>
    <package name="src">
      <classes>
        <class filename="src/good.ts" line-rate="0.92"/>
        <class filename="src/bad.ts" line-rate="0.55"/>
        <class filename="src/okay.ts" line-rate="0.81"/>
      </classes>
    </package>
  </packages>
</coverage>
`;

const JSON_COVERAGE = {
  total: { lines: { pct: 88.5 } },
  'src/foo.ts': { lines: { pct: 95 } },
  'src/bar.ts': { lines: { pct: 60 } },
  'src/baz.ts': { lines: { pct: 80 } },
};

describe('dod_check_coverage handler', () => {
  beforeEach(() => {
    fixtureDir = '';
  });
  afterEach(() => {
    fixtureDir = '';
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('dod_check_coverage');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses_coverage_xml — cobertura format, passing threshold', async () => {
    const path = await tempFile('coverage.xml', COBERTURA_XML);
    const result = await handler.execute({ threshold: 80, coverage_file: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.percentage).toBe(85);
    expect(parsed.passed).toBe(true);
    expect(parsed.files_below_threshold.map((f: { path: string }) => f.path)).toEqual([
      'src/bad.ts',
    ]);
  });

  test('parses_coverage_json — istanbul summary format', async () => {
    const path = await tempFile('coverage.json', JSON.stringify(JSON_COVERAGE));
    const result = await handler.execute({ threshold: 85, coverage_file: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.percentage).toBe(88.5);
    expect(parsed.passed).toBe(true);
    expect(parsed.files_below_threshold.length).toBe(2);
  });

  test('identifies_files_below_threshold — xml', async () => {
    const path = await tempFile('coverage.xml', COBERTURA_XML);
    const result = await handler.execute({ threshold: 90, coverage_file: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.passed).toBe(false);
    // bad.ts (55) and okay.ts (81) are below 90
    expect(parsed.files_below_threshold.length).toBe(2);
  });

  test('missing_coverage_file_returns_error', async () => {
    const result = await handler.execute({
      threshold: 80,
      coverage_file: '/tmp/nonexistent-coverage-xyz.xml',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('not found');
  });

  test('threshold_boundary — exactly at threshold is passed', async () => {
    const path = await tempFile(
      'coverage.json',
      JSON.stringify({ total: { lines: { pct: 80 } } }),
    );
    const result = await handler.execute({ threshold: 80, coverage_file: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.passed).toBe(true);
  });

  test('no_coverage_file_discovery_fails', async () => {
    fixtureDir = `/tmp/dod-coverage-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await Bun.write(`${fixtureDir}/.keep`, '');
    Bun.spawnSync({ cmd: ['rm', `${fixtureDir}/.keep`] });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({ threshold: 80 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no coverage file found');
  });

  test('schema_validation — rejects missing threshold', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects threshold outside 0-100', async () => {
    const result = await handler.execute({ threshold: 120 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
