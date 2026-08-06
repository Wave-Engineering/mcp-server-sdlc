/**
 * The not-found convention, enforced (#493) — and its first two consumers (#491,
 * #492).
 *
 * This module existed with ONE caller and NO tests, which is an odd state for a
 * mechanism whose entire purpose is to make a failure mode unrepresentable: the
 * thing enforcing the rule was itself unverified.
 *
 * The three rungs it exists to close, hardest last:
 *
 *   1. **Cannot distinguish** — a failed query renders as a legitimate zero.
 *   2. **Asserts which it was** — names a cause for what is only an observation.
 *   3. **Supplies evidence for the wrong one** — the suggested verify command
 *      reproduces the *failing* lookup, so an operator who checks gets an empty
 *      result that appears to CONFIRM the false cause.
 *
 * Rung 3 is the one worth the mechanism: a defect that survives being checked,
 * because it recruits the check. The guard is that the verify line is DERIVED
 * from the argv that ran, so it cannot disagree with the query.
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyRun,
  describeEmptyResult,
  describeFailedQuery,
  renderArgv,
  shortRefName,
} from './query-outcome.js';
import type { RunResult } from './error-norm.js';

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    stdout: '[]',
    stderr: '',
    argv: ['gh', 'run', 'list', '--branch', 'v1.1.0'],
    ...over,
  };
}

describe('rung 1 — a failed query is not an empty one', () => {
  test('a non-zero exit classifies as failed, never as zero results', () => {
    const out = classifyRun(run({ exitCode: 1, stderr: 'unknown flag' }), JSON.parse, 'CI runs');
    expect(out.succeeded).toBe(false);
    if (out.succeeded) throw new Error('unreachable');
    expect(out.kind).toBe('exec');
  });

  test('unparseable output on a zero exit is ALSO a failed query', () => {
    // The other half of how #491 stayed silent: the command "worked" and
    // returned something that could not be read, which is not evidence of
    // absence either.
    const out = classifyRun(run({ stdout: 'not json' }), JSON.parse, 'CI runs');
    expect(out.succeeded).toBe(false);
    if (out.succeeded) throw new Error('unreachable');
    expect(out.kind).toBe('parse');
  });

  test('a genuine empty result succeeds and must be unwrapped explicitly', () => {
    const out = classifyRun(run({ stdout: '[]' }), JSON.parse, 'CI runs');
    expect(out.succeeded).toBe(true);
    if (!out.succeeded) throw new Error('unreachable');
    expect(out.value).toEqual([]);
  });

  test('the two outcomes are not interchangeable values', () => {
    const failed = classifyRun(run({ exitCode: 1 }), JSON.parse, 'CI runs');
    const empty = classifyRun(run({ stdout: '[]' }), JSON.parse, 'CI runs');
    expect(failed).not.toEqual(empty);
    // A caller cannot read `.value` off the failure without narrowing — that is
    // the type-level half, and this asserts the runtime shape backs it up.
    expect('value' in failed).toBe(false);
  });
});

describe('rung 2 — observation, not cause', () => {
  test('an empty result states what ran and claims no cause', () => {
    const msg = describeEmptyResult({
      what: 'CI run',
      detail: "for ref 'v1.1.0'",
      argv: ['gh', 'run', 'list', '--branch', 'v1.1.0'],
    });
    expect(msg).toContain('The query RAN and returned nothing');
    // The exact wording #492 shipped, which the tool had no evidence for.
    expect(msg).not.toContain('may not have been triggered');
    expect(msg).not.toContain('has not been pushed');
  });

  test('hypotheses are permitted but must be labelled unverified', () => {
    const msg = describeEmptyResult({
      what: 'CI run',
      argv: ['gh', 'run', 'list'],
      hypotheses: ['the pipeline was not triggered'],
    });
    expect(msg).toContain('NOT verified');
    // The guess must not be able to read as a finding.
    const guessIdx = msg.indexOf('the pipeline was not triggered');
    const labelIdx = msg.indexOf('NOT verified');
    expect(labelIdx).toBeLessThan(guessIdx);
  });

  test('a failed query says so, in different words from an empty one', () => {
    const failed = describeFailedQuery({
      what: 'CI runs',
      failure: 'exit 1',
      argv: ['gh', 'run', 'list'],
    });
    const empty = describeEmptyResult({ what: 'CI run', argv: ['gh', 'run', 'list'] });
    expect(failed).toContain('FAILED QUERY');
    expect(failed).not.toEqual(empty);
    // Distinguishable in a transcript, not merely in the type system.
    expect(empty).not.toContain('FAILED QUERY');
  });
});

describe('rung 3 — the verify line cannot disagree with the query', () => {
  test('the suggested command is byte-equivalent to the argv that ran', () => {
    // THE ANTI-RUNG-3 GUARD. #492's hint rendered the failing lookup, so
    // following the tool's own advice produced a result that confirmed its
    // wrong diagnosis. Deriving from argv makes the suggestion and the query
    // the same object.
    const argv = ['gh', 'run', 'list', '--branch', 'v1.1.0', '--repo', 'o/r'];
    const msg = describeEmptyResult({ what: 'CI run', argv });
    expect(msg).toContain(renderArgv(argv));
  });

  test('an argv needing quoting still round-trips into the message', () => {
    const argv = ['gh', 'pr', 'create', '--title', 'plan(#42): a b — c'];
    const msg = describeEmptyResult({ what: 'PR', argv });
    expect(msg).toContain(renderArgv(argv));
    // Shell-escaped, so the line is actually copy-pasteable rather than merely
    // present.
    expect(renderArgv(argv)).toContain("'plan(#42): a b — c'");
  });

  test('failed-query messages derive their command the same way', () => {
    const argv = ['gh', 'run', 'list', '--branch', 'refs/tags/v1.1.0'];
    const msg = describeFailedQuery({ what: 'CI runs', failure: 'exit 1', argv });
    expect(msg).toContain(renderArgv(argv));
  });
});

describe('shortRefName — the #492 lookup defect', () => {
  test('a tag ref is reduced to the bare name gh actually matches', () => {
    // Measured live: `--branch refs/tags/v8.2.0` returned 0 runs where
    // `--branch v8.2.0` returned 2, for the same tag.
    expect(shortRefName('refs/tags/v1.1.0')).toBe('v1.1.0');
  });

  test('branch and remote refs are reduced too', () => {
    expect(shortRefName('refs/heads/main')).toBe('main');
    expect(shortRefName('refs/remotes/origin/main')).toBe('origin/main');
  });

  test('an already-short ref is unchanged', () => {
    expect(shortRefName('main')).toBe('main');
    expect(shortRefName('v1.1.0')).toBe('v1.1.0');
  });

  test('a ref merely CONTAINING the prefix is not mangled', () => {
    // Only a prefix counts; a branch legitimately named like this must survive.
    expect(shortRefName('feature/refs/tags/thing')).toBe('feature/refs/tags/thing');
  });
});
