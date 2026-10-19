/**
 * Single-quote-and-escape one argv element so it can be joined with spaces
 * into a single shell command string for `execSync`.
 *
 * Wraps the value in single quotes and escapes embedded single quotes via
 * the `'\''` four-char sequence. Safe for arbitrary user-supplied strings —
 * titles, bodies, branch names, commit messages — that the shell will then
 * word-split.
 *
 * Extracted from `pr_merge.ts` / `pr_create.ts` per Story 1.3 (first adapter
 * migration to need a shared subprocess-boundary helper).
 *
 * **Contract:** call this on RAW argv values, never on already-escaped strings
 * (double-escaping silently corrupts the value). The canonical use is
 * `cmd.map(shellEscape).join(' ')` inside `runArgv` (`lib/shared/error-norm.ts`)
 * — adapter callers should pass raw values to `runArgv` and let it escape.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Characters the shell never interprets, so a token made only of them needs no quotes. */
const SHELL_INERT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * {@link shellEscape}, except a token made only of shell-inert characters is
 * left bare (Python's `shlex.quote` rule). Same safety, but the joined command
 * stays readable and copy-pasteable in error messages:
 * `glab api 'projects/g%2Fp/pipelines?ref=main&per_page=20'`, not every token
 * wrapped in quotes. Same contract: RAW argv values only.
 */
export function shellQuote(value: string): string {
  return SHELL_INERT.test(value) ? value : shellEscape(value);
}
