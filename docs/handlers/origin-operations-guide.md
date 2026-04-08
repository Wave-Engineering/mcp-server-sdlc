# Origin Operations — Handler Implementation Guide

**Audience:** a cold-walk-in contributor adding or modifying a handler in the Origin Operations tool family (PR/MR lifecycle + CI inspection) of `mcp-server-sdlc`.

**Goal:** give you every pattern, skeleton, field mapping, and response schema you need to land a new handler in one pass — without reverse-engineering the convention from neighboring files.

**Read this if you are about to touch any of:**
`pr_create`, `pr_status`, `pr_wait_ci`, `pr_merge`, `pr_diff`, `pr_comment`, `pr_files`, `pr_list`, `ci_run_status`, `ci_run_logs`, `ci_failed_jobs`, `ci_runs_for_branch`, `ci_wait_run`.

---

## Table of contents

1. [Orientation: what an Origin Operations handler is](#1-orientation)
2. [Per-handler pattern reference](#2-per-handler-pattern-reference)
   - [2.1 File layout & registry codegen](#21-file-layout--registry-codegen)
   - [2.2 Canonical `HandlerDef` skeleton](#22-canonical-handlerdef-skeleton)
   - [2.3 Platform detection boilerplate](#23-platform-detection-boilerplate)
   - [2.4 Why per-handler duplication (no `lib/platform.ts`)](#24-why-per-handler-duplication-no-libplatformts)
   - [2.5 Shell-out convention: `child_process.execSync`](#25-shell-out-convention-childprocessexecsync)
   - [2.6 Error envelope + common error codes](#26-error-envelope--common-error-codes)
   - [2.7 Test convention](#27-test-convention)
   - [2.8 Cross-reference header (put this at the top of your handler)](#28-cross-reference-header)
3. [gh ↔ glab field mapping tables](#3-gh--glab-field-mapping-tables)
4. [Normalized response schemas (zod)](#4-normalized-response-schemas-zod)
5. [Self-check before you open a PR](#5-self-check)

---

## 1. Orientation

Every Origin Operations tool is a thin, platform-neutral shell around `gh` or `glab`. The same call works whether the repo lives on GitHub or GitLab; the handler detects platform at call time, shells to the right binary, parses the JSON, and reshapes it into a normalized response.

What the handler does NOT do:
- It does not cache, rate-limit, or retry (caller handles retries).
- It does not embed judgment (commit-message drafting, review reasoning — those stay in skills).
- It does not touch the filesystem beyond `/tmp` for transient payloads.
- It does not `import` from `lib/` for platform concerns. See [§2.4](#24-why-per-handler-duplication-no-libplatformts).

What the handler DOES:
- Validates input with a zod schema.
- Detects platform inline (~5–10 lines).
- Shells to `gh` / `glab` via `child_process.execSync`.
- Parses JSON, reshapes into the family's normalized response schema (see [§4](#4-normalized-response-schemas-zod)).
- Wraps everything in an `{ ok: true, data }` / `{ ok: false, error }` envelope.

---

## 2. Per-handler pattern reference

### 2.1 File layout & registry codegen

```
handlers/
  pr_create.ts         ← you add this file
  _registry.ts         ← AUTO-GENERATED; never edit by hand; git-ignored
tests/
  pr_create.test.ts    ← flat layout, no `tests/handlers/` subdirectory
```

`scripts/ci/codegen-handlers.sh` scans `handlers/*.ts` (excluding `_*.ts`) and regenerates `handlers/_registry.ts` on every build/test/validate. That means:

- Drop your new file in `handlers/`.
- Do NOT touch `handlers/_registry.ts`, `index.ts`, `routing.test.ts`, `smoke.sh`, or anything in `scripts/ci/`.
- Run `./scripts/ci/validate.sh` — codegen runs first, tsc lints everything, bun runs tests, then the smoke test asserts the new tool is exposed.

> **Max parallelism:** this codegen pattern exists so multiple contributors can land handlers in parallel without touching shared files. Don't defeat it by adding imports to a shared lib. See [§2.4](#24-why-per-handler-duplication-no-libplatformts).

### 2.2 Canonical `HandlerDef` skeleton

Copy-paste and rename. Every Origin Operations handler follows this exact shape.

```typescript
// handlers/<tool_name>.ts
//
// Origin Operations family. See docs/handlers/origin-operations-guide.md
// for the pattern reference, gh ↔ glab field mapping, and normalized
// response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

// ---- input schema ---------------------------------------------------------

const inputSchema = z.object({
  number: z.number().int().positive(),
  // ... tool-specific fields; see §4 for the response side
});

type Input = z.infer<typeof inputSchema>;

// ---- platform detection (inline — see §2.3 and §2.4) ----------------------

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = exec('git remote get-url origin');
    return url.includes('github') ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}

// ---- platform implementations --------------------------------------------

function runGithub(args: Input) {
  const raw = exec(`gh pr view ${args.number} --json number,state,url,headRefName,baseRefName`);
  const parsed = JSON.parse(raw) as {
    number: number;
    state: string;
    url: string;
    headRefName: string;
    baseRefName: string;
  };
  return {
    number: parsed.number,
    state: parsed.state.toLowerCase(),
    url: parsed.url,
    head: parsed.headRefName,
    base: parsed.baseRefName,
  };
}

function runGitlab(args: Input) {
  const raw = exec(`glab mr view ${args.number} --output json`);
  const parsed = JSON.parse(raw) as {
    iid: number;
    state: string;
    web_url: string;
    source_branch: string;
    target_branch: string;
  };
  return {
    number: parsed.iid,
    state: parsed.state === 'opened' ? 'open' : parsed.state,
    url: parsed.web_url,
    head: parsed.source_branch,
    base: parsed.target_branch,
  };
}

// ---- handler definition ---------------------------------------------------

const myHandler: HandlerDef = {
  name: 'my_tool',
  description: 'One-line description that appears in tools/list',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const platform = detectPlatform();
      const data = platform === 'github' ? runGithub(args) : runGitlab(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data }) }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default myHandler;
```

**Non-negotiables** (tsc and routing tests will catch you otherwise):
- Default export is the `HandlerDef` object. No named exports.
- `inputSchema` is a zod schema attached to the `HandlerDef`.
- `execute` is `async` and returns `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
- Every response — success, validation failure, runtime failure — uses the same `{ ok, data?, error? }` envelope, JSON-stringified into the single text block.

### 2.3 Platform detection boilerplate

This is the 5–10 line stanza every handler in the family copies. Do not extract it. Do not import it. It is intentionally inline. See [§2.4](#24-why-per-handler-duplication-no-libplatformts) for why.

```typescript
import { execSync } from 'child_process';

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = exec('git remote get-url origin');
    return url.includes('github') ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}
```

That's it. This is a proven, copy-pasteable block — it's what `handlers/ibm.ts` does today and what every Origin Operations handler should do.

**Notes:**
- No `.claude-project.md` read. The epic spec mentions it as an aspirational first step, but the actual convention — see `handlers/ibm.ts` — is `git remote get-url origin` directly. Stay consistent with what exists.
- The `catch` returning `'github'` is the default. If you're in a non-git directory (tests, usually) the handler still runs and returns the github branch; mock the command in tests to force gitlab.
- If you need the current branch, use `exec('git branch --show-current')`. Don't import anything.

### 2.4 Why per-handler duplication (no `lib/platform.ts`)

Deliberate. Not an oversight.

- **Origin Operations is a Wave-1 parallel burst.** 13 handler stories plus this guide land simultaneously. A shared `lib/platform.ts` would turn that into a single-file bottleneck with merge conflicts and cross-story serialization.
- **The duplicated cost is ~10 lines per handler** — worth it to keep stories independent.
- **No `import` from `lib/` for platform concerns.** If you find yourself reaching for shared code, stop and duplicate instead. Deduplication is a later-epic concern, after the shape has stabilized across all 13 tools.

If a pattern repeats verbatim across 10+ handlers and becomes a clear pain point, that's a follow-up chore — not this epic. Optimize after the curve flattens, not before.

### 2.5 Shell-out convention: `child_process.execSync`

**Use `child_process.execSync`.** This is the codebase reality: 27 of 36 handlers shell out, and every single one uses `execSync` from `child_process`. Examples: `handlers/ibm.ts`, `handlers/work_item.ts`, `handlers/wave_init.ts`, `handlers/wave_compute.ts`, etc.

```typescript
import { execSync } from 'child_process';

// simple case — one-shot, parse JSON
const raw = execSync('gh pr view 42 --json number,state,url', { encoding: 'utf8' }).trim();
const parsed = JSON.parse(raw);
```

**Why not `Bun.spawnSync`?** Earlier epic prose (including the parent epic #311 and some sub-issue specs) recommends `Bun.spawnSync` on the grounds of Bun-native APIs and easier mocking. That guidance was aspirational and never executed at scale — every handler shipped to date uses `child_process.execSync`, the test infrastructure (`mock.module('child_process', …)`) is built around it, and switching individual handlers to `Bun.spawnSync` breaks the test pattern the rest of the family depends on. **Match the convention, not the aspiration.**

**Gotchas:**
- `execSync` throws on non-zero exit. Always wrap in `try/catch` and convert to the `{ ok: false, error }` envelope.
- `execSync` returns a `Buffer` unless you pass `{ encoding: 'utf8' }`. Always pass the encoding.
- Always `.trim()` the output before parsing or comparing — `gh`/`glab` often append a trailing newline.
- For commands with user-provided strings (titles, bodies), either pass via `--body-file` with a temp file (see `handlers/work_item.ts:writeTempBody`) or be paranoid about quoting. Prefer the temp-file route for anything multi-line or containing special characters.
- For `gh`/`glab` JSON flags: `gh` uses `--json field1,field2,...`; `glab` uses `--output json` (no field selection). Parse the entire GitLab response and pick what you need.

### 2.6 Error envelope + common error codes

Every response — success or failure — is a single JSON object in a single text block:

```typescript
// success
{ ok: true, data: { /* normalized response — see §4 */ } }

// failure (validation, platform error, timeout, etc.)
{ ok: false, error: "human-readable message" }

// success-with-warning (closed issue, missing optional thing, etc.)
{ ok: true, warning: "...", ...fields }
```

When failure is deterministic and the caller needs to react differently depending on cause, add a `code` field alongside `error`:

```typescript
{ ok: false, error: "No workflow runs found for ref a3a1522", code: "no_runs_found" }
```

**Common codes across the family** — use these names verbatim when they apply, so callers can match on them:

| Code                    | Meaning                                                                  | Used by                                    |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `no_runs_found`         | `gh run list` / `glab ci list` returned zero runs for the ref            | `ci_run_status`, `ci_wait_run`             |
| `no_pr_found`           | no PR/MR matches the branch/number/filter                                | `pr_status`, `pr_list`, `pr_diff`, ...     |
| `invalid_ref`           | ref is neither a valid SHA nor a known branch                            | `ci_run_status`, `ci_wait_run`             |
| `timeout`               | polling loop exceeded `timeout_sec` before terminal state                | `pr_wait_ci`, `ci_wait_run`                |
| `merge_blocked`         | merge rejected by branch protection or conflicts                         | `pr_merge`                                 |
| `merge_queue_required`  | direct squash rejected because merge queue is enforced — retry with auto | `pr_merge`                                 |
| `platform_unsupported`  | feature not available on detected platform (e.g., merge queue on GitLab) | `pr_merge` (GitLab auto-queue request)     |
| `invalid_poll_interval` | caller passed `poll_interval_sec < 5`                                    | `pr_wait_ci`, `ci_wait_run`                |
| `log_fetch_failed`      | `gh run view --log*` / `glab ci trace` failed                            | `ci_run_logs`                              |
| `unknown_platform`      | `git remote get-url origin` returned neither github nor gitlab           | all (rare — caller should fix their remote) |

Don't invent new codes for the same meaning — grep this table first.

### 2.7 Test convention

Tests live **flat in `tests/`** — there is no `tests/handlers/` subdirectory. Do not create one. The path is `tests/<tool_name>.test.ts`.

> The parent epic's issue prose says `tests/handlers/<tool>.test.ts`. That is wrong. Every existing test file is flat. Match the convention that compiles, not the convention that was written down.

The canonical test pattern mocks `child_process.execSync` at module load time via a call-registry. Copy-paste this skeleton from `tests/ibm.test.ts`:

```typescript
// tests/my_tool.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
let execRegistry: Record<string, string> = {};
let execError: Error | null = null;

function mockExec(cmd: string): string {
  if (execError) throw execError;
  for (const [key, value] of Object.entries(execRegistry)) {
    if (cmd.includes(key)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// IMPORTANT: import AFTER the mock is registered
const { default: myHandler } = await import('../handlers/my_tool.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = {};
  execError = null;
});

describe('my_tool handler', () => {
  test('github happy path', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr view 42'] = JSON.stringify({
      number: 42,
      state: 'OPEN',
      url: 'https://github.com/org/repo/pull/42',
      headRefName: 'feature/42-x',
      baseRefName: 'main',
    });

    const result = await myHandler.execute({ number: 42 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect((data.data as any).number).toBe(42);
  });

  test('gitlab happy path', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr view 42'] = JSON.stringify({
      iid: 42,
      state: 'opened',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/42',
      source_branch: 'feature/42-x',
      target_branch: 'main',
    });

    const result = await myHandler.execute({ number: 42 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect((data.data as any).head).toBe('feature/42-x');
  });

  test('validation failure — missing required field', async () => {
    const result = await myHandler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });
});
```

**Gotchas:**
- The `await import(...)` must come AFTER `mock.module(...)`. Static `import` at the top of the file bypasses the mock.
- `execRegistry` matches by `cmd.includes(key)` — use a prefix that uniquely identifies each command you need to intercept. If two keys both match, the order is insertion order, so be specific.
- `beforeEach` resets the registry — no state leaks between tests.
- For polling tools (`pr_wait_ci`, `ci_wait_run`), you will need a sequence of registry values across calls. The easiest approach is a counter + array of responses; see how you'd extend the `mockExec` helper to track call counts.

### 2.8 Cross-reference header

**Put this at the top of every new Origin Operations handler** (right above the imports) so future contributors can find this guide:

```typescript
// Origin Operations family. See docs/handlers/origin-operations-guide.md
// for the pattern reference, gh ↔ glab field mapping, and normalized
// response schemas.
```

Three lines. It's not a doc comment — just a comment block. It satisfies the AC's "cross-referenced from at least one existing Origin Operations handler file via comment header" requirement as the tool handlers land alongside this guide in Wave 1.

> **Note for reviewers of this doc story:** this guide ships in the same Wave-1 parallel burst as the 13 handler files. Handler authors paste the stanza above when they create their file. This doc does not reach into any handler file directly (parallel-worktree safety rule).

---

## 3. gh ↔ glab field mapping tables

Every table below has three columns: **GitHub JSON path** → **GitLab JSON path** → **our normalized field**. Rows are the fields you'll use for that tool's implementation and response. Gotchas are called out under each table.

### Command reference

| Platform | Discovery command                            | JSON flag              |
| -------- | -------------------------------------------- | ---------------------- |
| GitHub   | `gh <noun> view --help` to see `--json` keys | `--json field1,field2` |
| GitLab   | `glab <noun> view --help`                    | `--output json` (full) |

GitHub lets you request only the fields you need; GitLab always dumps the whole object — parse and pick. GitLab numeric IDs for issues/MRs are `iid` (project-scoped); use that, not the global `id`.

### 3.1 `pr_create`

| GitHub (`gh pr view --json ...`) | GitLab (`glab mr view --output json`) | Normalized field |
| -------------------------------- | -------------------------------------- | ---------------- |
| `number`                         | `iid`                                  | `number`         |
| `url`                            | `web_url`                              | `url`            |
| `state` (lowercase `open`)       | `state` (`opened`)                     | `state` (`open`) |
| `headRefName`                    | `source_branch`                        | `head`           |
| `baseRefName`                    | `target_branch`                        | `base`           |

**Gotchas:**
- `gh pr create` doesn't return JSON. Create then immediately `gh pr view <num> --json number,url,state,headRefName,baseRefName` to get the normalized response.
- `glab mr create --yes` prints the URL on stdout; parse the trailing URL and re-query with `glab mr view` for the full object. Pattern proven in `handlers/work_item.ts:parseOutput`.
- For multi-line bodies, write a temp file (`/tmp/pr-body-<ts>.md`) and pass via `--body-file` (gh) or `--description "$(cat path)"` (glab). Do NOT inline multi-line content on the command line — it breaks quoting in obvious and non-obvious ways.

### 3.2 `pr_status`

| GitHub                                            | GitLab                                                | Normalized field                |
| ------------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| `state` (OPEN/CLOSED/MERGED → lowercase)          | `state` (`opened`/`closed`/`merged`)                  | `state`                         |
| `mergeStateStatus` (CLEAN/DIRTY/BLOCKED/UNSTABLE) | `detailed_merge_status` (`mergeable`, `broken_status`, `blocked_status`, `ci_must_pass`, ...) | `merge_state` (`clean`/`dirty`/`blocked`/`unstable`/`unknown`) |
| `mergeable` (boolean)                             | `merge_status` (`can_be_merged`/`cannot_be_merged`)   | `mergeable` (boolean)           |
| `url`                                             | `web_url`                                             | `url`                           |
| `checks[].name` + `checks[].conclusion` (from `gh pr checks --json name,state,conclusion`) | `pipeline.status` (`success`/`failed`/`running`/`pending`) | `checks.summary` (`all_passed`/`has_failures`/`pending`/`none`) |

**Normalization rules:**
- GitHub `mergeStateStatus`:
  - `CLEAN` → `clean`
  - `UNSTABLE` (checks failing but mergeable) → `unstable`
  - `DIRTY` (conflicts) → `dirty`
  - `BLOCKED` → `blocked`
  - anything else → `unknown`
- GitLab `detailed_merge_status`:
  - `mergeable` → `clean`
  - `broken_status` / conflict-class → `dirty`
  - `blocked_status` / `ci_must_pass` / `not_approved` → `blocked`
  - otherwise → `unknown`
- **Loud gotcha:** GitHub uses a per-check array; GitLab collapses into a single `pipeline.status`. You lose per-check granularity on GitLab — that's fine for `checks.summary`, but don't promise individual check names in the response.

### 3.3 `pr_wait_ci`

Same fields as `pr_status`; this tool wraps `pr_status` logic in a poll loop.

| Concept              | GitHub mechanism                                     | GitLab mechanism                                |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| "all checks done"    | every `checks[].status === 'completed'`              | `pipeline.status in (success, failed, canceled)` |
| "any check failed"   | any `checks[].conclusion in (failure, cancelled, timed_out)` | `pipeline.status === 'failed'`                  |
| "all checks passed"  | every `conclusion === 'success'`                     | `pipeline.status === 'success'`                 |

**Gotcha:** on GitHub, exit the loop as soon as ANY check fails — do NOT wait for the other checks to finish. Match GitLab's single-status terminal semantics where possible.

### 3.4 `pr_merge`

| GitHub (`gh pr merge`) / (`gh pr view --json mergeCommit`) | GitLab (`glab mr merge`) | Normalized field             |
| ---------------------------------------------------------- | ------------------------ | ---------------------------- |
| `mergeCommit.oid`                                          | `merge_commit_sha`       | `merge_commit_sha`           |
| `state === 'MERGED'`                                       | `state === 'merged'`     | `merged` (boolean)           |
| `url`                                                      | `web_url`                | `url`                        |
| (n/a — inferred from retry)                                | (n/a — always direct)    | `merge_method` (`direct_squash` / `merge_queue`) |
| (merge queue position — not exposed by gh CLI reliably)    | (n/a)                    | `queue_position`             |

**Command flags:**
| Action         | GitHub                                                              | GitLab                                                                      |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| squash + delete| `gh pr merge <n> --squash --delete-branch [--body <msg>]`           | `glab mr merge <n> --squash --remove-source-branch --yes [--squash-message <msg>]` |
| auto (queue)   | `gh pr merge <n> --squash --auto --delete-branch [--body <msg>]`    | n/a (GitLab has no merge-queue concept; return `platform_unsupported` if caller forces it) |

**Gotchas:**
- If direct squash returns stderr containing `merge strategy for main is set by the merge queue` (or similar repo-protection text), retry with `--auto`. Report `merge_method: 'merge_queue'` in the response so the caller knows.
- GitLab's squash commit message flag is `--squash-message`, NOT `--body`. Don't typo this.
- To fetch the final `merge_commit_sha` on GitHub, follow up with `gh pr view <n> --json state,mergeCommit` after merge returns. Direct-squash merges populate it immediately; merge-queue merges may return `null` until the queue lands.

### 3.5 `pr_diff`

| GitHub           | GitLab           | Normalized field |
| ---------------- | ---------------- | ---------------- |
| `gh pr diff <n>` (stdout, unified diff) | `glab mr diff <n>` (stdout, unified diff) | `diff` (string)  |
| (compute from diff)                    | (compute from diff)                        | `line_count`     |
| (compute: count `diff --git` occurrences) | (same)                                  | `file_count`     |
| `gh pr view <n> --json url`            | `glab mr view <n> --output json → web_url`| `url`            |

**Gotchas:**
- `gh pr diff` uses Git's standard unified diff output — straightforward.
- `glab mr diff` format has historically been inconsistent across `glab` versions. Verify the format before shipping; if in doubt, prefer `glab mr view <n> --output json` and reconstruct from the `changes[].diff` field.
- Truncation safety valve: if `line_count > 10000`, keep first 5000 + last 5000 with a marker line; set `truncated: true`.

### 3.6 `pr_comment`

| GitHub                                                       | GitLab                                               | Normalized field |
| ------------------------------------------------------------ | ---------------------------------------------------- | ---------------- |
| `gh pr comment <n> --body <body>` + parse comment URL        | `glab mr note <n> --message <body>` (stdout has note URL/ID) | `comment_id`     |
| URL parsed from stdout or re-queried via `gh pr view <n> --json comments[]` | `web_url` from create response                   | `url`            |

**Gotchas:**
- GitHub's `gh pr comment` does not print the comment ID directly. Either parse the comment URL from stdout (regex `/issuecomment-(\d+)$/`) or query `gh pr view <n> --json comments` and pick the newest.
- GitLab comments on MRs are called "notes" — use `glab mr note`, not `glab mr comment`.
- For multi-line comments, same rule as bodies: temp file + `--body-file` (gh) / `--message "$(cat path)"` (glab).

### 3.7 `pr_files`

| GitHub (`gh pr view --json files`) | GitLab (`glab mr view --output json → changes[]`)                      | Normalized field |
| ---------------------------------- | ----------------------------------------------------------------------- | ---------------- |
| `files[].path`                     | `changes[].new_path` (or `old_path` if deleted)                         | `files[].path`   |
| `files[].additions`                | compute by parsing `changes[].diff` — count `^+` lines minus `^+++` lines | `files[].additions` |
| `files[].deletions`                | compute by parsing `changes[].diff` — count `^-` lines minus `^---` lines | `files[].deletions` |
| `files[].changeType` (ADDED/MODIFIED/REMOVED/RENAMED) | `changes[].new_file` / `deleted_file` / `renamed_file` flags | `files[].status` (`added`/`modified`/`removed`/`renamed`) |

**Status normalization for GitLab:**
- `new_file: true` → `added`
- `deleted_file: true` → `removed`
- `renamed_file: true` → `renamed`
- neither → `modified`

**Loud gotcha:** GitLab does NOT return precomputed `additions`/`deletions`. You MUST parse the diff hunks to compute them. Don't skip this — `/review` relies on it for scoping.

### 3.8 `pr_list`

| GitHub (`gh pr list --json number,title,state,headRefName,baseRefName,url`) | GitLab (`glab mr list --output json`) | Normalized field |
| --------------------------------------------------------------------------- | --------------------------------------- | ---------------- |
| `number`       | `iid`              | `prs[].number` |
| `title`        | `title`            | `prs[].title`  |
| `state` (lowercase) | `state` (`opened`/`closed`/`merged`) | `prs[].state` |
| `headRefName`  | `source_branch`    | `prs[].head`   |
| `baseRefName`  | `target_branch`    | `prs[].base`   |
| `url`          | `web_url`          | `prs[].url`    |

**Filter flag mapping:**
| Filter  | GitHub              | GitLab                 |
| ------- | ------------------- | ---------------------- |
| head    | `--head <branch>`   | `--source-branch <branch>` |
| base    | `--base <branch>`   | `--target-branch <branch>` |
| state   | `--state <state>`   | `--state <state>`      |
| author  | `--author <user>`   | `--author <user>`      |
| limit   | `--limit <n>`       | `--per-page <n>`       |

### 3.9 `ci_run_status`

| GitHub (`gh run list --json ...`)                | GitLab (`glab ci list --output json`)   | Normalized field   |
| ------------------------------------------------ | ---------------------------------------- | ------------------ |
| `databaseId`                                     | `id`                                     | `run_id`           |
| `name`                                           | `ref` or `source` (workflow name is weaker on GitLab — pipelines are per-commit, not per-workflow) | `workflow_name`    |
| `status` (`queued`/`in_progress`/`completed`)    | `status` (`created`/`pending`/`running`/`success`/`failed`/`canceled`/`skipped`) | `status` (`queued`/`in_progress`/`completed`) |
| `conclusion` (`success`/`failure`/`cancelled`/`skipped`/`timed_out`/null) | (derived from GitLab `status` when terminal) | `conclusion` |
| `url`                                            | `web_url`                                | `url`              |
| `headBranch`                                     | `ref`                                    | `ref`              |
| `headSha`                                        | `sha`                                    | `sha`              |
| `createdAt`                                      | `created_at`                             | `created_at`       |
| `updatedAt` (fallback) / `completedAt` when present | `finished_at` / `updated_at`           | `finished_at`      |

**GitLab status-to-GitHub normalization:**
- `success` → `status: 'completed'`, `conclusion: 'success'`
- `failed` → `status: 'completed'`, `conclusion: 'failure'`
- `canceled` → `status: 'completed'`, `conclusion: 'cancelled'`
- `skipped` → `status: 'completed'`, `conclusion: 'skipped'`
- `running` → `status: 'in_progress'`, `conclusion: null`
- `pending` / `created` / `scheduled` → `status: 'queued'`, `conclusion: null`

**Loud gotchas:**
- GitLab has **no real per-workflow filter**. A single pipeline runs all jobs. If the caller passes `workflow_name`, list pipelines and match the ref/name as best you can; if no match, return `no_runs_found`.
- SHA refs vs branch refs: on GitHub use `--commit <sha>` vs `--branch <ref>`; on GitLab use `--sha <sha>` vs `--branch <ref>`. Detect with a 40-char hex regex.
- If the list is empty, return `{ ok: false, error: "...", code: "no_runs_found" }`.

### 3.10 `ci_run_logs`

| GitHub                                        | GitLab                                                     | Normalized field |
| --------------------------------------------- | ---------------------------------------------------------- | ---------------- |
| `gh run view <run_id> --log` (full) / `--log-failed` / `--job <job_id>` → stdout | `glab ci trace <job_id>` → stdout (requires job_id) | `logs` (string)  |
| (count `\n`)                                  | (count `\n`)                                               | `line_count`     |
| (boolean from truncation step)                | (boolean from truncation step)                             | `truncated`      |
| `gh run view <run_id> --json url`             | `glab api projects/:id/pipelines/<run_id>` → `web_url`     | `url`            |

**Gotchas:**
- `ci_run_logs` needs a `job_id` on GitLab — pipelines are containers; `trace` is per-job. If the caller doesn't pass `job_id`, first call `glab api projects/:id/pipelines/<run_id>/jobs`, pick the first failed job (or the caller-specified name), then `trace` it.
- Hard cap at 10000 lines regardless of caller override. Keep first 5000 + last 5000, insert `... [N lines omitted] ...` marker. Pathological jobs have emitted 2M+ lines historically.
- `gh run view --log-failed` returns only failed-step logs on GitHub — preferred when `failed_only: true`.

### 3.11 `ci_failed_jobs`

| GitHub (`gh run view <run_id> --json jobs`)            | GitLab (`glab api projects/:id/pipelines/<run_id>/jobs`) | Normalized field |
| ------------------------------------------------------ | ---------------------------------------------------------- | ---------------- |
| `jobs[].databaseId`                                    | `id`                                                       | `failed_jobs[].job_id` |
| `jobs[].name`                                          | `name`                                                     | `failed_jobs[].name` |
| **(n/a — GitHub has no stages)**                       | `stage`                                                    | `failed_jobs[].stage` (null on GitHub) |
| `jobs[].conclusion` (`failure` / `cancelled` / ...)    | `status` (`failed` / `canceled` / ...)                     | `failed_jobs[].conclusion` |
| `jobs[].startedAt`                                     | `started_at`                                               | `failed_jobs[].started_at` |
| `jobs[].completedAt`                                   | `finished_at`                                              | `failed_jobs[].finished_at` |
| `jobs[].url`                                           | `web_url`                                                  | `failed_jobs[].url` |

**Filter logic:**
- GitHub: include a job if `status === 'completed' && conclusion !== 'success'`
- GitLab: include a job if `status === 'failed'`

**Loud gotcha:** GitHub has no pipeline-stage concept — every job is top-level. Set `stage: null` in the normalized response and document it in the response schema. Callers that want to group by stage need to check for non-null.

### 3.12 `ci_runs_for_branch`

Shape identical to `ci_run_status` but returned as `runs: [...]`. Same field mapping.

**Filter flag mapping:**
| Filter      | GitHub                       | GitLab                    |
| ----------- | ---------------------------- | ------------------------- |
| branch      | `--branch <name>`            | `--branch <name>`         |
| status      | `--status <completed/queued/in_progress>` | `--status <success/failed/running/pending>` |
| limit       | `--limit <n>`                | `--per-page <n>`          |

**Status filter normalization (caller-to-platform):**
| Caller           | GitHub              | GitLab              |
| ---------------- | ------------------- | ------------------- |
| `"success"`      | (list completed, filter `conclusion === 'success'` client-side) | `--status success` |
| `"failure"`      | (list completed, filter `conclusion === 'failure'` client-side) | `--status failed`  |
| `"in_progress"`  | `--status in_progress` | `--status running` |
| `"all"`          | no filter           | no filter           |

GitHub's `--status` only takes pipeline-level states; conclusion-level filtering is client-side. That's a real asymmetry — document it in your error paths.

### 3.13 `ci_wait_run`

Same field mapping as `ci_run_status`; this tool wraps `ci_run_status` logic in a poll loop. See §4 for the response shape (it returns `final_status`, not `conclusion`, because it has already polled past terminal state).

**Gotchas:**
- Handle "no run yet" specially. If called immediately after a push, the pipeline may not exist for the first 10–60s. Wait up to 60s for a run to appear BEFORE starting the main wait loop — do NOT time out with `no_runs_found`.
- Enforce `poll_interval_sec >= 5` as a hard floor; return `invalid_poll_interval` if the caller violates it.
- Log each poll cycle to stderr: `[ci_wait_run] ref=a3a1522 t=20s status=in_progress`. Stderr goes to the MCP server log, NOT the tool response.

---

## 4. Normalized response schemas (zod)

These are the wire-level schemas every handler in the family returns as its success `data`. Keep them platform-neutral. Use the same field names. If GitLab genuinely can't provide a field, use `null` and document it in §3.

```typescript
// docs/handlers/origin-operations-guide.md — §4
// NOTE: these schemas are a reference. Each handler declares them inline in its
// own file. We do NOT import from a shared schemas.ts — intentional duplication
// for max Wave-1 parallelism. See §2.4.

import { z } from 'zod';

// ---- Shared primitives ----------------------------------------------------

const prStateSchema = z.enum(['open', 'closed', 'merged']);
const mergeStateSchema = z.enum(['clean', 'unstable', 'dirty', 'blocked', 'unknown']);
const checksSummarySchema = z.enum(['all_passed', 'has_failures', 'pending', 'none']);
const runStatusSchema = z.enum(['queued', 'in_progress', 'completed']);
const runConclusionSchema = z.enum([
  'success', 'failure', 'cancelled', 'skipped', 'timed_out',
]).nullable();
const finalStatusSchema = z.enum(['success', 'failure', 'cancelled', 'timed_out']);

// ---- 4.1 pr_create --------------------------------------------------------

export const prCreateResponse = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.literal('open'),
  head: z.string(),
  base: z.string(),
});

// ---- 4.2 pr_status --------------------------------------------------------

export const prStatusResponse = z.object({
  number: z.number().int().positive(),
  state: prStateSchema,
  merge_state: mergeStateSchema,
  mergeable: z.boolean(),
  checks: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    summary: checksSummarySchema,
  }),
  url: z.string().url(),
});

// ---- 4.3 pr_wait_ci -------------------------------------------------------

export const prWaitCiResponse = z.object({
  number: z.number().int().positive(),
  final_state: z.enum(['passed', 'failed', 'timed_out']),
  checks: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    summary: checksSummarySchema,
  }),
  waited_sec: z.number().int().nonnegative(),
  url: z.string().url(),
});

// ---- 4.4 pr_merge ---------------------------------------------------------

export const prMergeResponse = z.object({
  number: z.number().int().positive(),
  merged: z.boolean(),
  merge_method: z.enum(['direct_squash', 'merge_queue']),
  url: z.string().url(),
  merge_commit_sha: z.string().optional(),   // direct_squash only
  queue_position: z.number().int().optional(), // merge_queue only (if ever knowable)
});

// ---- 4.5 pr_diff ----------------------------------------------------------

export const prDiffResponse = z.object({
  number: z.number().int().positive(),
  diff: z.string(),
  line_count: z.number().int().nonnegative(),
  file_count: z.number().int().nonnegative(),
  truncated: z.boolean(),                    // true if we cut the diff
  url: z.string().url(),
});

// ---- 4.6 pr_comment -------------------------------------------------------

export const prCommentResponse = z.object({
  number: z.number().int().positive(),
  comment_id: z.number().int().positive(),
  url: z.string().url(),
});

// ---- 4.7 pr_files ---------------------------------------------------------

export const prFileEntrySchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const prFilesResponse = z.object({
  number: z.number().int().positive(),
  files: z.array(prFileEntrySchema),
  total_additions: z.number().int().nonnegative(),
  total_deletions: z.number().int().nonnegative(),
});

// ---- 4.8 pr_list ----------------------------------------------------------

export const prListEntrySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: prStateSchema,
  head: z.string(),
  base: z.string(),
  url: z.string().url(),
});

export const prListResponse = z.object({
  prs: z.array(prListEntrySchema),
});

// ---- 4.9 ci_run_status ----------------------------------------------------

export const ciRunStatusResponse = z.object({
  run_id: z.number().int().positive(),
  workflow_name: z.string(),
  status: runStatusSchema,
  conclusion: runConclusionSchema,
  url: z.string().url(),
  ref: z.string(),
  sha: z.string(),
  created_at: z.string(),                    // ISO 8601
  finished_at: z.string().nullable(),        // ISO 8601 | null (still running)
});

// ---- 4.10 ci_run_logs -----------------------------------------------------

export const ciRunLogsResponse = z.object({
  run_id: z.number().int().positive(),
  job_id: z.number().int().nullable(),       // null if whole-run logs (GitHub only)
  logs: z.string(),
  line_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  url: z.string().url(),
});

// ---- 4.11 ci_failed_jobs --------------------------------------------------

export const ciFailedJobSchema = z.object({
  job_id: z.number().int().positive(),
  name: z.string(),
  stage: z.string().nullable(),              // null on GitHub (no stages)
  conclusion: z.string(),                    // platform-specific string; see §3.11
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  url: z.string().url(),
});

export const ciFailedJobsResponse = z.object({
  run_id: z.number().int().positive(),
  failed_jobs: z.array(ciFailedJobSchema),
});

// ---- 4.12 ci_runs_for_branch ----------------------------------------------

export const ciRunEntrySchema = z.object({
  run_id: z.number().int().positive(),
  workflow_name: z.string(),
  status: runStatusSchema,
  conclusion: runConclusionSchema,
  sha: z.string(),
  url: z.string().url(),
  created_at: z.string(),
});

export const ciRunsForBranchResponse = z.object({
  runs: z.array(ciRunEntrySchema),
});

// ---- 4.13 ci_wait_run -----------------------------------------------------

export const ciWaitRunResponse = z.object({
  run_id: z.number().int().positive(),
  workflow_name: z.string(),
  final_status: finalStatusSchema,
  url: z.string().url(),
  ref: z.string(),
  sha: z.string(),
  waited_sec: z.number().int().nonnegative(),
});
```

**Implementation hint:** your handler doesn't need to validate its own output against these schemas at runtime — `inputSchema` is enough for the MCP layer. The schemas above are a spec, not a runtime check. But if a handler-under-test diverges from this shape, the `routing.test.ts` contract test or `/review` will catch it before merge.

---

## 5. Self-check

Before you open your PR on a new Origin Operations handler, walk this list:

- [ ] File at `handlers/<tool>.ts`, default export is a `HandlerDef`.
- [ ] Comment-header stanza from [§2.8](#28-cross-reference-header) at the top.
- [ ] `import { execSync } from 'child_process'` — not `Bun.spawnSync`.
- [ ] Platform detection inline ([§2.3](#23-platform-detection-boilerplate)) — no import from `lib/`.
- [ ] zod `inputSchema` validates every argument, including optional ones with defaults.
- [ ] Response shape matches the relevant schema in [§4](#4-normalized-response-schemas-zod) (field names, nullability, primitive types).
- [ ] Every `execSync` call wrapped in `try/catch` → `{ ok: false, error }` envelope.
- [ ] Error codes for deterministic failures match the table in [§2.6](#26-error-envelope--common-error-codes).
- [ ] GitHub AND GitLab paths both exercised, with the same normalized response shape.
- [ ] Gotchas from the relevant §3 subsection addressed (e.g., GitLab additions/deletions computed from diff hunks; GitLab stage is nullable; SHA-vs-branch ref detection).
- [ ] Test file at `tests/<tool>.test.ts` — **flat**, not under `tests/handlers/`.
- [ ] Test file uses `mock.module('child_process', ...)` pattern from [§2.7](#27-test-convention).
- [ ] Test covers: GitHub happy path, GitLab happy path, validation failure, at least one error-code case.
- [ ] `./scripts/ci/validate.sh` passes locally (codegen → tsc → shellcheck → bun test → smoke).
- [ ] You did NOT modify: `handlers/_registry.ts`, `index.ts`, `routing.test.ts`, `scripts/ci/smoke.sh`, or anything in `scripts/ci/`.

If all boxes are checked, you're landing a handler that looks like every other handler in the family — which is exactly the point.
