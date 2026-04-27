import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// This handler uses Bun.file() for local reads and does not shell out. Tests
// operate against real temp files under /tmp and flip CLAUDE_PROJECT_DIR to
// point at a fixture root that carries a phases-waves.json under
// .claude/status/.

const { default: handler } = await import('../handlers/devspec_finalize.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function getCheck(
  parsed: { checks: Array<{ check: string; pass: boolean; evidence: string }> },
  name: string,
) {
  const c = parsed.checks.find(x => x.check === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

async function writeTempSpec(content: string): Promise<string> {
  const path = `/tmp/devspec-finalize-deps-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

/**
 * A minimal spec that will fail several of the other 7 checks — we're only
 * asserting against the depends_on check here, so the other checks' state is
 * irrelevant. Keeping the spec small isolates the test intent.
 */
const MINIMAL_SPEC = `# Minimal Spec

## 5. Detailed Design

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README.md | Docs | 1 | \`README.md\` | Wave 1 | required | |

## 6. Test Plan

### 6.4 Manual Verification Procedures

(none)

## 7. Definition of Done

- [ ] Deliverables Manifest produced
`;

async function setupProjectDir(plan: object | null): Promise<string> {
  const root = `/tmp/devspec-finalize-depson-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  if (plan !== null) {
    await Bun.write(`${root}/.claude/status/phases-waves.json`, JSON.stringify(plan));
  } else {
    // Touch the root so it exists but has no .claude/status/phases-waves.json.
    await Bun.write(`${root}/.sentinel`, '');
  }
  process.env.CLAUDE_PROJECT_DIR = root;
  return root;
}

describe('devspec_finalize — depends_on check', () => {
  const ORIGINAL_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    // Each test sets its own; restore the original in afterEach.
  });

  afterEach(() => {
    if (ORIGINAL_PROJECT_DIR === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
    }
  });

  test('check name is registered and returned by finalize', async () => {
    await setupProjectDir(null);
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    const names = parsed.checks.map((c: { check: string }) => c.check);
    expect(names).toContain('depends_on');
    expect(parsed.total).toBe(8);
  });

  test('phases-waves.json absent → check passes with "not yet written" evidence', async () => {
    await setupProjectDir(null);
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(true);
    expect(check.evidence.toLowerCase()).toContain('not yet written');
  });

  test('all Stories have depends_on (mix of empty + populated) → check passes', async () => {
    const plan = {
      phases: [
        {
          name: 'phase1',
          waves: [
            {
              id: 'w1',
              stories: [
                { number: 101, title: 'foo', depends_on: [] },
                { number: 102, title: 'bar', depends_on: [] },
              ],
            },
            {
              id: 'w2',
              stories: [
                { number: 201, title: 'baz', depends_on: ['w1'] },
              ],
            },
          ],
        },
      ],
    };
    await setupProjectDir(plan);
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(true);
    expect(check.evidence).toContain('3/3');
  });

  test('one Story missing depends_on → check fails naming that Story', async () => {
    const plan = {
      phases: [
        {
          waves: [
            {
              id: 'w1',
              stories: [
                { number: 101, title: 'foo', depends_on: [] },
                { number: 102, title: 'bar' }, // missing depends_on
              ],
            },
          ],
        },
      ],
    };
    await setupProjectDir(plan);
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('#102');
    expect(check.evidence).not.toContain('#101');
    expect(check.evidence.toLowerCase()).toContain("'depends_on'");
    expect(parsed.ready_for_approval).toBe(false);
  });

  test('multiple Stories missing depends_on → error names every offender', async () => {
    const plan = {
      phases: [
        {
          waves: [
            {
              id: 'w1',
              stories: [
                { number: 101, title: 'ok', depends_on: [] },
                { number: 102, title: 'missing-1' },
                { number: 103, title: 'missing-2' },
              ],
            },
            {
              id: 'w2',
              stories: [
                { number: 201, title: 'missing-3' },
              ],
            },
          ],
        },
      ],
    };
    await setupProjectDir(plan);
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('#102');
    expect(check.evidence).toContain('#103');
    expect(check.evidence).toContain('#201');
    expect(check.evidence).not.toContain('#101');
  });

  test('Story with depends_on: null → counted as missing', async () => {
    const plan = {
      phases: [
        {
          waves: [
            {
              id: 'w1',
              stories: [
                { number: 101, title: 'null-deps', depends_on: null },
              ],
            },
          ],
        },
      ],
    };
    await setupProjectDir(plan);
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('#101');
  });

  test('legacy shape using `issues` (not `stories`) is also checked', async () => {
    // wave_next_pending.test.ts uses `issues` — accept that legacy shape so we
    // don't diverge from the live schema still in use elsewhere.
    const plan = {
      phases: [
        {
          waves: [
            {
              id: 'w1',
              issues: [
                { number: 301, title: 'legacy-shape' }, // missing depends_on
              ],
            },
          ],
        },
      ],
    };
    await setupProjectDir(plan);
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(false);
    expect(check.evidence).toContain('#301');
  });

  test('empty plan (no phases) → check passes', async () => {
    await setupProjectDir({});
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(true);
    expect(check.evidence.toLowerCase()).toContain('no stories');
  });

  test('malformed phases-waves.json → check fails with parse error', async () => {
    const root = `/tmp/devspec-finalize-depson-bad-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await Bun.write(`${root}/.claude/status/phases-waves.json`, '{ not valid json');
    process.env.CLAUDE_PROJECT_DIR = root;
    const path = await writeTempSpec(MINIMAL_SPEC);
    const result = await handler.execute({ path });
    const parsed = parseResult(result);
    const check = getCheck(parsed, 'depends_on');
    expect(check.pass).toBe(false);
    expect(check.evidence.toLowerCase()).toContain('failed to parse');
  });
});
