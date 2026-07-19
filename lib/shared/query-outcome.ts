/**
 * Query outcomes that cannot silently collapse "found nothing" into "did not
 * look" (#493).
 *
 * ## Why this exists
 *
 * Three defects reported in one night shared one shape: a result that could not
 * distinguish *checked and found nothing* from *did not look*. They form a
 * ladder, each rung harder to catch than the last:
 *
 *   1. **Cannot distinguish** — `pr_status` rendered a failed `gh pr checks`
 *      invocation as `checks: none` for a PR with four passing checks (#491).
 *      Catching it requires suspicion.
 *   2. **Asserts which it was** — `ci_wait_run` named "the pipeline may not have
 *      been triggered" as the cause of what was only a failed lookup (#492).
 *      Catching it requires disbelieving a plausible explanation.
 *   3. **Supplies evidence for the wrong one** — that same message suggested
 *      `gh run list --branch <ref>` using the ref that had just failed to match,
 *      so an operator who followed the advice got an empty result that appeared
 *      to *confirm* the false cause.
 *
 * Rung 3 is why this is a module and not a style guide: it is a defect that
 * survives being checked, because the tool hands you a reproduction that agrees
 * with its own wrong diagnosis. It does not evade "go verify it yourself" — it
 * recruits it.
 *
 * ## The convention this enforces
 *
 * > A not-found result states WHAT WAS QUERIED and WHAT CAME BACK, and nothing
 * > else. Any hypothesis is SEPARATED AND LABELLED as such. Any suggested
 * > command MUST REPRODUCE THE QUERY ACTUALLY PERFORMED.
 *
 * The third clause is enforced structurally: renderers derive their verification
 * line from `RunResult.argv` — the argv that actually ran — so a suggestion
 * cannot describe a different query than the one performed. The empty-result
 * renderer lands with #492, the issue that consumes it; shipping it here with
 * no caller would be dead code.
 *
 * ## What this does NOT cover
 *
 * Twelve adapter files still call `execSync` directly rather than `runArgv`, so
 * they carry no argv and get neither the derived verification line nor the
 * type-level discrimination. Migrating them is tracked separately; until then
 * this mechanism covers the `runArgv` callers only.
 */

import type { RunResult } from './error-norm.js';
import { shellEscape } from './shell-escape.js';

/**
 * The outcome of a lookup, as two DIFFERENT types rather than one value that
 * happens to be empty.
 *
 * `succeeded: false` cannot be read as "zero results" without explicitly
 * unwrapping it, which is the point: #491 existed because a failed query and an
 * empty one were the same value.
 */
export type QueryOutcome<T> =
  | { succeeded: true; value: T }
  | {
      succeeded: false;
      /**
       * WHY it failed, kept distinct because "the command failed" and "the
       * command succeeded and returned garbage" are different diagnoses.
       * Collapsing them is the same distinguishability loss this module exists
       * to prevent — it would just move the collapse one level down.
       */
      kind: 'exec' | 'parse';
      failure: string;
      argv: string[];
    };

/**
 * Classify a `RunResult` into a `QueryOutcome`.
 *
 * A non-zero exit is a FAILED QUERY, never an empty one. Callers that want to
 * report "none" must first prove the query ran, which makes #491's silent
 * `summary: 'none'` unrepresentable rather than merely discouraged.
 *
 * `parse` runs only on success; if it throws (unparseable payload) that is also
 * a failed query, not an empty one — the other half of how #491 stayed silent.
 */
export function classifyRun<T>(
  result: RunResult,
  parse: (stdout: string) => T,
  what: string,
): QueryOutcome<T> {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
    return {
      succeeded: false,
      kind: 'exec',
      failure: `${what} query failed (exit ${String(result.exitCode)}): ${detail}`,
      argv: result.argv,
    };
  }
  try {
    return { succeeded: true, value: parse(result.stdout) };
  } catch (err) {
    return {
      succeeded: false,
      kind: 'parse',
      failure:
        `${what} query returned unparseable output: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      argv: result.argv,
    };
  }
}

/** Render an argv array as a copy-pasteable shell command. */
export function renderArgv(argv: string[]): string {
  return argv.map(shellEscape).join(' ');
}

/**
 * Describe a lookup that could not be performed.
 *
 * Deliberately distinct wording from `describeEmptyResult` so the two are
 * distinguishable in logs and transcripts, not just in types.
 */
export function describeFailedQuery(opts: {
  what: string;
  failure: string;
  argv: string[];
}): string {
  return (
    `Could not determine ${opts.what}: ${opts.failure}. ` +
    `This is a FAILED QUERY, not an empty result — the state is unknown, not absent. ` +
    `Command run: ${renderArgv(opts.argv)}`
  );
}
