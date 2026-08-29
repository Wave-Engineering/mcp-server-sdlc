// Oracle for the type-aware adapter-error-code rule (#534).
//
// Runs the real checker (scripts/ci/check-adapter-error-code.ts) against the
// fixtures under tests/fixtures/adapter-error-code/ and asserts the four rows
// of the story's Test Procedures table:
//
//   | AdapterResult relay without code           | rule flags it            |
//   | AdapterResult relay with code (either order)| rule passes              |
//   | local result type (no code field)          | rule does NOT flag       |
//   | catch block relaying err instanceof Error  | rule does NOT flag       |

import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { checkFiles } from '../scripts/ci/check-adapter-error-code.ts';

const FX_DIR = resolve(import.meta.dir, 'fixtures', 'adapter-error-code');
const fx = (name: string): string => resolve(FX_DIR, name);

const FIXTURES = {
  flag: 'flag-nonresult-multiline.fixture.ts',
  pass: 'pass-code-both-orders.fixture.ts',
  local: 'local-result-no-code.fixture.ts',
  catch: 'catch-relay.fixture.ts',
} as const;

// One program build for the whole suite — checkFiles scans exactly the targets
// passed, so handing it all four fixtures at once partitions cleanly by file.
const allTargets = Object.values(FIXTURES).map(fx);
const violations = checkFiles(allTargets);
const forFixture = (name: string) => violations.filter((v) => resolve(v.file) === fx(name));

describe('check-adapter-error-code (type-aware, #534)', () => {
  it('flags an AdapterResult relay that omits code — regardless of variable name or multi-line shape', () => {
    const hits = forFixture(FIXTURES.flag);
    expect(hits.length).toBe(1);
    // Keyed on the type, not the name: the offending var is `prResult`, not `result`.
    expect(hits[0]!.varName).toBe('prResult');
    expect(hits[0]!.message).toContain('omits');
  });

  it('passes an AdapterResult relay that preserves code — code before OR after error', () => {
    expect(forFixture(FIXTURES.pass)).toEqual([]);
  });

  it('does NOT flag a local (non-AdapterResult) result type whose ok:false arm has no code', () => {
    expect(forFixture(FIXTURES.local)).toEqual([]);
  });

  it('does NOT flag a catch block relaying `err instanceof Error`', () => {
    expect(forFixture(FIXTURES.catch)).toEqual([]);
  });

  it('flags exactly one violation across all four fixtures (no false positives)', () => {
    expect(violations.length).toBe(1);
  });
});
