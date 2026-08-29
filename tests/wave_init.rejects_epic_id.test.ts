// Story 2.1 (#362) — legacy shape rejected: passing the old
// `kahuna: { epic_id, slug }` shape must fail with a schema validation error,
// not silently coerce or proceed. The handler's `kahuna` sub-schema is
// `.strict()` so `epic_id` is an unrecognized key; `plan_id` is also missing
// — either path yields ok:false.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  mockExecSync,
} from '../lib/test-support/mock-child-process.ts';
// Shared `fs` mock (#456) — see mock-fs.ts header; the handler's transitive
// `logger.ts` → `node:fs` pull requires the full logger trio in the surface.
import { installFsMock, resetFsMock } from '../lib/test-support/mock-fs.ts';

installChildProcessMock();
installFsMock();

const { default: handler } = await import('../handlers/wave_init.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function clearEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

describe('wave_init — legacy { epic_id, slug } shape is rejected (Story 2.1 / #362)', () => {
  beforeEach(() => {
    resetExecMock();
    setExecMock(() => 'wave plan initialized\n');
    resetFsMock();
  });
  afterEach(clearEnv);

  test('epic_id shape → ok:false with schema error; no subprocess invoked', async () => {
    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      // Deliberately the legacy shape. TS would catch this at compile time in
      // consumer code; at runtime the schema must catch it too.
      kahuna: { epic_id: 42, slug: 'legacy-shape' } as unknown as {
        plan_id: number;
        slug: string;
      },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
    // The error is a zod validation complaint — it mentions either the
    // unrecognized `epic_id` key or the missing `plan_id` field (both are
    // unambiguously schema failures).
    const errorText = parsed.error as string;
    const mentionsLegacy = errorText.includes('epic_id');
    const mentionsRequired = errorText.includes('plan_id');
    expect(mentionsLegacy || mentionsRequired).toBe(true);

    // No CLI call should have been made — the schema gate fires first.
    expect(mockExecSync.mock.calls.length).toBe(0);
  });
});
