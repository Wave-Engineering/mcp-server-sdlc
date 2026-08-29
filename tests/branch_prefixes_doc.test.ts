// Doc-consistency gate (#449): CLAUDE.md's documented branch-prefix set MUST
// match the canonical `BRANCH_PREFIXES` constant. The plural `docs` in CLAUDE.md
// was the drift that misdirected an agent (`docs/75-...` rejected by `ibm`, #448)
// — docs advertising a prefix the tools reject is a trap. This test fails loudly
// if the two ever diverge again.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BRANCH_PREFIXES } from '../lib/shared/branch-prefixes.ts';

const CLAUDE_MD = readFileSync(join(import.meta.dir, '..', 'CLAUDE.md'), 'utf8');

describe('CLAUDE.md branch-prefix documentation', () => {
  test('the "Canonical <type> prefixes" line lists exactly the BRANCH_PREFIXES set, in order', () => {
    // Find the single line that declares the canonical set. The prefixes follow
    // the LAST colon on that line; everything before it (prose, the source-file
    // path, the `doc/`/`docs/` contrast) is ignored.
    const line = CLAUDE_MD.split('\n').find(
      (l) => /Canonical\s+`?<type>`?\s+prefixes/i.test(l),
    );
    expect(line, 'CLAUDE.md must declare a "Canonical <type> prefixes" line').toBeDefined();

    const afterColon = line!.slice(line!.lastIndexOf(':') + 1);
    const documented = [...afterColon.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    expect(documented).toEqual([...BRANCH_PREFIXES]);
  });

  test('CLAUDE.md never documents a plural `docs/` branch prefix', () => {
    // The commit-type `docs` (conventional commits) and the `docs/` directory
    // are legitimate; a `docs/` used as a BRANCH prefix (followed by <N> or a
    // description) is the trap. Guard the branch-prefix shape specifically.
    expect(CLAUDE_MD).not.toMatch(/`docs\/(?:<N>|\d)/);
  });
});
