# Adapter Architecture — Canonical Reference

**Audience:** maintainers adding platform-aware methods, fixing cross-platform
bugs, or auditing asymmetries between GitHub and GitLab.
**Status:** Phase 2 complete (25 methods migrated); Phase 3 deletion work
in progress.
**Cross-refs:** `docs/platform-adapter-retrofit-devspec.md` (Dev Spec),
`docs/adapters/survey.md` (Phase 1 survey), `lib/adapters/types.ts`
(the typed contract itself).

---

## 1. The Contract

Every platform adapter implements the `PlatformAdapter` interface declared in
`lib/adapters/types.ts`. Every method returns an `AdapterResult<T>` — a
three-way discriminated union that forces callers to handle success, runtime
failure, and structural cross-platform asymmetry as three distinct code paths.

### 1.1 `AdapterResult<T>` — the discriminator

```ts
export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string }
  | { platform_unsupported: true; hint: string };
```

- `{ ok: true, data }` — the call succeeded; `data` is the normalized payload.
- `{ ok: false, error, code }` — runtime failure (subprocess non-zero exit,
  malformed JSON, invalid args). `code` is a short machine-readable slug the
  handler can branch on; `error` is the human-readable message.
- `{ platform_unsupported: true, hint }` — the REQUESTED OPERATION has no
  meaningful equivalent on the active platform. This is the typed signal that
  replaces the pre-retrofit silent-ignore pattern (R-03).

Pre-retrofit, the silent-ignore case collapsed into wrong behavior: e.g.
`work_item(type: "mr")` on GitHub silently ran the GitHub PR sub-command
instead of refusing. The third union arm makes that asymmetry an explicit,
test-visible signal (`{ platform_unsupported: true, hint: 'use type="pr" on
GitHub' }`, #281). Not every asymmetry is typed this way, though — a flag that
is merely meaningless, like `skip_train` on GitLab, is dropped with a
`warnings` entry instead (§4.1).

### 1.2 `PlatformAdapter` interface

Full verbatim from `lib/adapters/types.ts:815-880`:

```ts
export interface PlatformAdapter {
  // PR/MR family (Stories 1.3 – 1.11)
  prCreate(args: PrCreateArgs): Promise<AdapterResult<PrCreateResponse>>;
  prMerge(args: PrMergeArgs): Promise<AdapterResult<PrMergeResponse>>;
  prMergeWait(args: PrMergeWaitArgs): Promise<AdapterResult<PrMergeWaitResponse>>;
  prStatus(args: PrStatusArgs): Promise<AdapterResult<PrStatusResponse>>;
  prDiff(args: PrDiffArgs): Promise<AdapterResult<PrDiffResponse>>;
  prComment(args: PrCommentArgs): Promise<AdapterResult<PrCommentResponse>>;
  prFiles(args: PrFilesArgs): Promise<AdapterResult<PrFilesResponse>>;
  prList(args: PrListArgs): Promise<AdapterResult<PrListResponse>>;
  prWaitCi(args: PrWaitCiArgs): Promise<AdapterResult<PrWaitCiResponse>>;

  // CI family
  ciWaitRun(args: CiWaitRunArgs): Promise<AdapterResult<CiWaitRunResponse>>;
  ciRunStatus(args: CiRunStatusArgs): Promise<AdapterResult<CiRunStatusResponse>>;
  ciRunLogs(args: CiRunLogsArgs): Promise<AdapterResult<CiRunLogsResponse>>;
  ciFailedJobs(args: CiFailedJobsArgs): Promise<AdapterResult<CiFailedJobsResponse>>;
  ciRunsForBranch(args: CiRunsForBranchArgs): Promise<AdapterResult<CiRunsForBranchResponse>>;

  // Label & issue CRUD
  labelCreate(args: LabelCreateArgs): Promise<AdapterResult<NormalizedLabel>>;
  labelList(args: LabelListArgs): Promise<AdapterResult<LabelListResponse>>;
  workItem(args: WorkItemArgs): Promise<AdapterResult<WorkItemResponse>>;
  ibm(args: IbmArgs): Promise<AdapterResult<IbmResponse>>;
  epicSubIssues(args: EpicSubIssuesArgs): Promise<AdapterResult<EpicSubIssuesResponse>>;

  // Spec operations
  specGet(args: SpecGetArgs): Promise<AdapterResult<SpecGetResponse>>;
  specValidateStructure(args: SpecValidateStructureArgs): Promise<AdapterResult<SpecValidateStructureResponse>>;
  specAcceptanceCriteria(args: SpecAcceptanceCriteriaArgs): Promise<AdapterResult<SpecAcceptanceCriteriaResponse>>;
  specDependencies(args: SpecDependenciesArgs): Promise<AdapterResult<SpecDependenciesResponse>>;

  // Hybrid sub-calls.
  // `fetchPrState` is the first real hybrid (Story 1.11) — consumed by
  // `prMergeWait` and the per-platform `prMerge` adapters for state polling
  // and post-merge URL/sha lookup.
  // `fetchIssue` (Story 2.1) is the keystone sub-call for Phase 2 — consumed
  // by 10 handlers that all read the same normalized issue shape.
  // `ciListRuns` + `resolveBranchSha` (Story 2.19) are the `ci_wait_run`
  // keystone sub-calls — consumed by the polling loop in
  // `lib/ci-wait-run-poll.ts` and the Phase 0 merge-queue pre-flight.
  fetchIssue(args: FetchIssueArgs): Promise<AdapterResult<AdapterIssue>>;
  fetchPrState(args: FetchPrStateArgs): Promise<AdapterResult<PrStateInfo>>;
  fetchPrForBranch(
    args: FetchPrForBranchArgs,
  ): Promise<AdapterResult<PrForBranchRef | null>>;
  fetchIssueClosure(
    args: FetchIssueClosureArgs,
  ): Promise<AdapterResult<IssueClosureInfo>>;
  findMergedPrForBranchPrefix(
    args: FindMergedPrForBranchPrefixArgs,
  ): Promise<AdapterResult<{ url: string } | null>>;
  ciListRuns(
    args: CiListRunsArgs,
  ): Promise<AdapterResult<CiListRunsResponse>>;
  resolveBranchSha(
    args: ResolveBranchShaArgs,
  ): Promise<AdapterResult<ResolveBranchShaResponse | null>>;
  createBranch(args: CreateBranchArgs): Promise<AdapterResult<void>>;
  findExistingPr(
    args: FindExistingPrArgs,
  ): Promise<AdapterResult<NormalizedPr | null>>;
  fetchCiTrustSignal(
    args: FetchCiTrustSignalArgs,
  ): Promise<AdapterResult<CiTrustSignal>>;
}
```

Every method in the interface is also listed in the runtime registry
`PLATFORM_ADAPTER_METHODS` (`lib/adapters/types.ts:891-925`). The registry
powers the contract test (see §8); the compile-time `_methodsExhaustive`
check in `types.ts` catches drift in one direction (interface addition
without a registry entry); the runtime test catches the other (registry
entry without a method on each adapter object).

---

## 2. File Layout

```
lib/
  adapters/
    types.ts                         # PlatformAdapter + AdapterResult + all arg/response types
    types.test.ts                    # Contract test (R-04)
    index.ts                         # Public surface (getAdapter, types)
    route.ts                         # Dispatch: getAdapter() -> PlatformAdapter
    github.ts                        # Assembler: imports per-method GitHub impls
    gitlab.ts                        # Assembler: imports per-method GitLab impls
    <method>-github.ts               # One per method, GitHub implementation
    <method>-github.test.ts          # Colocated test for the GitHub impl
    <method>-gitlab.ts               # One per method, GitLab implementation
    <method>-gitlab.test.ts          # Colocated test for the GitLab impl
  shared/
    detect-platform.ts               # cwd-based platform detection (github|gitlab)
    error-norm.ts                    # runArgv() wrapper around subprocess calls
    git-remote.ts                    # git-ls-remote helpers (not platform CLI)
    parse-repo-slug.ts               # URL/remote -> "owner/repo" parse
    shell-escape.ts                  # argv quoting helpers
    truncate-logs.ts                 # platform-agnostic log truncation
handlers/
  <handler>.ts                       # Thin dispatch; no direct gh/glab calls
  <handler>.test.ts                  # Handler-level integration test
scripts/
  ci/
    gate-greps.sh                    # Enforces R-09 / R-10 against handlers/
    migration-allowlist.txt          # Handlers exempted from the gate
    validate.sh                      # Full CI: codegen + lint + gate-greps + tests
```

**Naming convention:** every adapter file is `<method>-<platform>.ts` using
kebab-case for the method and `-github.ts` / `-gitlab.ts` for the platform
suffix. The exported symbol follows camelCase: `prCreateGithub`,
`fetchIssueGitlab`, `resolveBranchShaGitlab`. The `<method>` part of the
filename matches the `PlatformAdapter` method name after kebab-case folding.

**Colocated tests.** Each `<method>-<platform>.ts` has a sibling
`<method>-<platform>.test.ts`. Tests mock at the subprocess boundary
(`child_process.execSync`) — not at the adapter module itself. This
boundary is an R-08 requirement; see §8 for the rationale.

**Shared code lives in `lib/shared/`.** Anything that is NOT platform-specific
(argv parsing, repo-slug parsing, git-ls-remote, log truncation, error
normalization) belongs there, not in a platform file. If you find yourself
writing a helper that both `github.ts` and `gitlab.ts` adapter files need,
move it to `lib/shared/`.

---

## 3. Dispatch Model

Handlers are platform-agnostic. They get a `PlatformAdapter` from
`getAdapter()` and call the single interface method for the operation
they want. The `getAdapter()` function picks the right adapter based on
cwd detection.

```ts
// lib/adapters/route.ts
export function getAdapter(_args?: { repo?: string }): PlatformAdapter {
  const platform = detectPlatform();
  return platform === 'gitlab' ? gitlabAdapter : githubAdapter;
}
```

`detectPlatform()` (`lib/shared/detect-platform.ts`) is sync; it inspects
`git remote -v` in the current working directory and returns `'github'`
or `'gitlab'`. `getAdapter` accepts a `{repo}` arg today for forward-
compatibility with cross-repo dispatch (Dev Spec §5.4) but does not
currently consume it — the signature is stable.

### 3.1 How a handler uses the adapter

```ts
// handlers/spec_get.ts — thin dispatcher
import { getAdapter } from '../lib/adapters/index.js';

export async function spec_get(args: { number: number, repo?: string }) {
  const result = await getAdapter({ repo: args.repo }).fetchIssue({
    number: args.number,
    repo: args.repo,
  });
  if ('platform_unsupported' in result) {
    return { ok: false, error: `spec_get: ${result.hint}` };
  }
  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code };
  }
  // Markdown parsing on `result.data.body` stays in the handler — platform-
  // agnostic logic belongs here, not in the adapter.
  return { ok: true, data: parseSections(result.data.body) };
}
```

The handler does three things and nothing else:
1. Validates its own args (schema-level).
2. Calls `getAdapter().<method>({...})`.
3. Unwraps `AdapterResult<T>` into the handler's response envelope.

A handler that does any of the following is violating the architecture:
- Direct `execSync('gh ...')` or `Bun.spawnSync('glab', ...)` calls.
- An `if (platform === 'github')` branch.
- An `import { gitlabApi* } from '../lib/glab.js'` (scheduled for deletion in Phase 3).

The gate-greps (§6) enforce the first two at CI time.

---

## 4. Typed Asymmetries (`platform_unsupported`)

Structural cross-platform differences — operations that exist on one platform
but not the other, or flags whose semantics don't translate — surface as
`{ platform_unsupported: true, hint: string }`. Callers handle that arm
explicitly instead of receiving a misleading "success". But **not every
asymmetry is typed this way** — when the operation still succeeds and only a
flag didn't apply, the adapter completes the call and adds a `warnings` entry
instead (§4.1). Reach for `platform_unsupported` only when there is a genuine
*refusal* the caller must handle.

### 4.1 The distinction: a `warnings` entry, not `platform_unsupported` (`skip_train`)

`skip_train` is the tempting-but-wrong case. GitHub's merge queue honors it;
GitLab's merge trains are auto-managed at the project level with no
client-side equivalent. Pre-retrofit, `skip_train: true` on GitLab silently
did nothing while the handler returned a fake `merged: true`.

The retrofit did **not** turn this into a typed asymmetry — because there is no
refusal to surface. The merge still proceeds; the flag is simply meaningless.
So `pr-merge-gitlab.ts` silently drops the flag and completes the merge, adding
one `warnings` entry (#423):

> `skip_train ignored on GitLab — merge trains are auto-managed at the project level`

That is the rule of thumb: `platform_unsupported` when the operation cannot be
honored and the caller must handle a refusal; a `warnings` entry when it still
succeeds but a flag or nuance didn't apply. `skip_train` is the latter. §4.2 is
a genuine `platform_unsupported` case.

### 4.2 Example: `work_item` cross-platform PR/MR asymmetry

`WorkItemArgs.type` accepts both `'pr'` (GitHub-only) and `'mr'`
(GitLab-only). Pre-retrofit, the handler dispatched to
`createGithubPR` regardless of the active platform on `type: 'pr'` — so on
a GitLab repo, `type: 'pr'` produced "gh: command not found" rather than a
meaningful error. The migrated adapters flag the mismatch as a typed
asymmetry:

```ts
// lib/adapters/work-item-gitlab.ts (excerpt)
if (args.type === 'pr') {
  return {
    platform_unsupported: true,
    hint: 'use type="mr" on GitLab',
  };
}
```

```ts
// lib/adapters/work-item-github.ts (excerpt)
if (args.type === 'mr') {
  return {
    platform_unsupported: true,
    hint: 'use type="pr" on GitHub',
  };
}
```

Bug closed: #281.

### 4.3 Example: `resolveBranchSha` on GitLab

`ci_wait_run`'s Phase 0 merge-queue pre-flight resolves a branch name to a
commit SHA so the polling loop can anchor against a specific commit. On
GitHub this is `gh api repos/:owner/:repo/commits/:branch`. On GitLab,
pipelines attach to branch names directly — the branch-to-SHA indirection
is unnecessary. For the `ci_wait_run` polling consumer, the GitLab adapter
declared the whole concept unsupported (Story 2.19):

```ts
// lib/adapters/resolve-branch-sha-gitlab.ts (excerpt, pre-2.22 stub shape)
return {
  platform_unsupported: true,
  hint: 'branch→SHA not needed — GitLab CI pipelines attach to branch names directly',
};
```

Story 2.22 (`wave_init`) then needed the real SHA on GitLab for the KAHUNA
branch bootstrap, so the stub was promoted to a real implementation. The
`ci-wait-run-poll.ts` consumer treats `platform_unsupported` and
`{ data: null }` identically, so promoting the stub was backward-compatible.
This is the canonical example of "start with a typed asymmetry stub; promote
only when a real consumer arrives."

### 4.4 When to use `platform_unsupported`

Use it only when the requested operation **cannot be honored** on the active
platform and the caller must handle the refusal:
- An argument value selects a sub-operation that only exists on one platform
  (§4.2, `work_item` `type`).
- A concept simply doesn't apply on the other platform (§4.3,
  `resolveBranchSha`).

Do NOT use `platform_unsupported` for:
- A flag that is merely *meaningless* on the other platform while the operation
  still succeeds — drop it and add a `warnings` entry instead (§4.1,
  `skip_train` on GitLab).
- Runtime failures (subprocess error, network failure) — those are `ok: false`.
- Features that could be implemented on both platforms but just haven't been
  yet — those either stay on the stub (`hint: 'not yet migrated'`, see
  `githubAdapter.ciWaitRun` for an example) or get implemented.

---

## 5. Where to add a new method

Adding a new platform-aware method means EIGHT file touches. The order
below is the one the Phase 1 and Phase 2 migrations followed — tests first,
implementation second, assembler wiring third, contract test and gate last.

1. **Define the arg / response types in `lib/adapters/types.ts`.** Name
   them `<Method>Args` / `<Method>Response`, following the existing naming
   convention (see `FetchIssueArgs` / `AdapterIssue` for a hybrid sub-call
   exemplar; `PrCreateArgs` / `PrCreateResponse` for a full-migration
   exemplar). The normalized response shape should be the intersection of
   what BOTH platforms can reasonably produce — don't bake in a GitHub-ism
   that GitLab can't populate.
2. **Add the method signature to the `PlatformAdapter` interface** (same
   file, the big block near the bottom). Group it with the family it
   belongs to (PR/MR, CI, label, spec, hybrid sub-call).
3. **Append the method name to `PLATFORM_ADAPTER_METHODS`** (same file).
   The compile-time `_methodsExhaustive` check forces this — skip it and
   `tsc` will fail.
4. **Create `lib/adapters/<method>-github.ts`** with the GitHub
   implementation. Import `execSync` from `child_process` (the subprocess
   boundary the test suite mocks). Wrap `gh ...` invocations via
   `runArgv` from `lib/shared/error-norm.ts`; that helper normalizes
   non-zero exits and argv errors. Use `parseRepoSlug` from
   `lib/shared/parse-repo-slug.ts` for cwd-derived slugs.
5. **Create `lib/adapters/<method>-gitlab.ts`** with the GitLab
   implementation. Same subprocess boundary, same `runArgv` wrapping.
   Resolve any asymmetries explicitly with a `platform_unsupported`
   return — do NOT silently no-op.
6. **Create colocated tests:** `<method>-github.test.ts` and
   `<method>-gitlab.test.ts`. Mock `child_process.execSync` via
   `mock.module` (see §8 for the pitfall on mock pollution). Assert
   against EXACT argv — per `lesson_origin_ops_pitfalls.md`, gh accepts
   `--jq`, bare-hex colors, and `--repo`; glab accepts NONE of those
   (`#RRGGBB`, `-R`, no `--jq`). Test stubs MUST fail loudly on wrong
   argv, not silently pass through. See §8 for the test pattern.
7. **Wire the per-platform impls into the assembler files:**
   `lib/adapters/github.ts` imports `<method>Github` and adds it to the
   `githubAdapter` object literal; `lib/adapters/gitlab.ts` does the same
   for GitLab. The contract test (§8) fails at runtime if either side is
   missing a method.
8. **Add the method to `MIGRATED_METHODS` in `lib/adapters/types.test.ts`.**
   Until then, the "still-stubbed methods return platform_unsupported"
   test expects your method to be a `'not yet migrated'` stub and
   fails now that it's real. See `lib/adapters/types.test.ts:89-116`.

### 5.1 Narrow sub-call vs. full-migration — how to choose

- **Full-migration** is the default shape: one handler has one dominant
  platform-specific body (>50% of LoC); lift the whole thing. Examples:
  `pr_create`, `ci_failed_jobs`, `work_item`, `label_create`.
- **Hybrid sub-call** is for handlers where the platform call is a small
  kernel wrapped in substantial non-platform orchestration (state-file
  I/O, markdown parsing, polling loops, artifact walks). Lift ONLY the
  platform kernel into a narrow typed sub-call; keep the orchestration
  in the handler or a peer `lib/*.ts` module. Examples: `spec_get`
  (markdown parsing stays in handler), `pr_merge_wait` (polling loop
  stays in `lib/pr-merge-wait-poll.ts`), `ci_wait_run` (polling loop
  stays in `lib/ci-wait-run-poll.ts`). See §7 for exemplars.

Pick hybrid when at least one of these is true: (a) the same sub-call is
needed by ≥2 handlers and deserves a narrower type than the full-migration
would give; (b) the non-platform orchestration is non-trivial (>100 LoC)
and lifting it into two platform files would duplicate state-machine code.

### 5.2 Example: "no server-side prefix filter? fall back to generous limit + client filter"

Pattern: a caller wants to find the first merged PR/MR whose source branch
starts with `prefix`. Neither `gh pr list` nor `glab mr list` exposes a
server-side branch-prefix filter. Instead of failing, the adapter fetches
a generous window (`limit` or `per_page`, default 100) and filters the
result client-side. The narrowness of the return shape (`{url: string} | null`)
discourages callers from probing with tiny limits — the semantic is "the
first match in a reasonable window, not a full repo scan". Signature:

```ts
findMergedPrForBranchPrefix(
  args: FindMergedPrForBranchPrefixArgs,
): Promise<AdapterResult<{ url: string } | null>>;
```

See `survey.md` §5.5 item #2 for the history: the pre-migration handler
hardcoded 50 and closed #282 by exposing `limit` as an arg with default 100.
The adapter boundary is where you pay that config — keep client filters
out of handlers.

---

## 6. Gate-greps

Two grep-based checks in `scripts/ci/gate-greps.sh` enforce the dispatch
model at CI time. They run against every file in `handlers/*.ts` whose
basename is NOT in the allowlist (`scripts/ci/migration-allowlist.txt`).

- **Gate 1 (R-09).** `grep -nE "platform === '(github|gitlab)'"` — inline
  platform branching. If a handler reads `platform === 'github'` anywhere
  (if, ternary, assignment) the gate fails. The handler should dispatch
  through `getAdapter()` instead. See `scripts/ci/gate-greps.sh:68`.
- **Gate 2 (R-10).** `grep -nE "execSync\(['\"\`](gh|glab) |Bun\.spawnSync"`
  — direct subprocess to `gh` / `glab` / `Bun.spawnSync`. Subprocess
  invocation lives in `lib/adapters/<method>-<platform>.ts` only. See
  `scripts/ci/gate-greps.sh:76`.

### 6.1 The allowlist

`scripts/ci/migration-allowlist.txt` is the EXCLUDE list — handlers in it
are exempt from the gate until their migration story removes them. Phase 1
started with 32 entries; Phase 2 closed at zero entries (empty file,
comments only). Phase 3 Story 3.6 deletes the file entirely; at that point
the gates enforce against every handler unconditionally.

**Regenerating.** The allowlist is NOT auto-regenerated. Each migration
story removes its handler's basename as part of the story's acceptance
criteria — the allowlist edit is the one shared file across parallel
wave flights and is commutatively safe (single-line removes from different
flights always merge cleanly).

### 6.2 Pointer

- Gate script: `scripts/ci/gate-greps.sh` (88 lines).
- Allowlist: `scripts/ci/migration-allowlist.txt`.
- Invoked by: `scripts/ci/validate.sh` (the full CI pipeline) between
  `bun run lint` and `shellcheck`.

---

## 7. Hybrid handlers + sub-calls

A hybrid handler keeps its non-platform orchestration (state files,
markdown parsing, polling loops, idempotent find-or-create dances) in the
handler or a peer `lib/*.ts` module, and pushes ONLY the platform kernel
into a narrow adapter sub-call.

### 7.1 Exemplar: `fetchPrState` (`pr_merge_wait` + `pr_merge`)

Shipped in Story 1.11 — the first hybrid sub-call. `pr_merge_wait`'s job
is "poll until the PR is merged on main, or time out." The polling state
machine (sleep injection, timeout accounting, detect-and-skip-already-merged)
is platform-agnostic and lives in `lib/pr-merge-wait-poll.ts`. The only
platform-specific bit is "what's the current state of PR N?" That's
`fetchPrState`:

```ts
export interface FetchPrStateArgs {
  number: number;
  repo?: string;
}

export type PrState = 'open' | 'merged' | 'closed';

export interface PrStateInfo {
  state: PrState;
  url: string;
  mergeCommitSha?: string;
}

fetchPrState(args: FetchPrStateArgs): Promise<AdapterResult<PrStateInfo>>;
```

The signature is narrower than `prStatus` (which returns checks, merge
state, mergeable flags — all unused by the poller). Narrowness is the
point: it means the poller needs less mock surface in its tests, and the
per-platform implementations can skip the fields they'd otherwise have
to fabricate.

The same sub-call is consumed by the per-platform `prMerge` adapters for
post-merge URL / sha lookup. Two consumers, one narrow shape.

### 7.2 Exemplar: `fetchIssue` (10 consumers)

Shipped in Story 2.1 — the keystone Phase 2 sub-call. Ten handlers
(`ibm`, `spec_get`, `spec_validate_structure`, `spec_acceptance_criteria`,
`spec_dependencies`, `epic_sub_issues`, `wave_compute`,
`wave_dependency_graph`, `wave_topology`, `dod_load_manifest`) need a
normalized issue record — number, title, state, url, body, labels — and
nothing else platform-specific. Every one of them also does its own
markdown / manifest / table parsing on top of `body`, and that parsing is
platform-agnostic.

```ts
export interface FetchIssueArgs {
  number: number;
  repo?: string;
}

export type IssueState = 'OPEN' | 'CLOSED';

export interface AdapterIssue {
  number: number;
  title: string;
  state: IssueState;
  url: string;
  body: string;
  labels: string[];
}

fetchIssue(args: FetchIssueArgs): Promise<AdapterResult<AdapterIssue>>;
```

State normalization (`OPEN | CLOSED`) is intentionally upper-case — GitHub
returns `OPEN/CLOSED`, GitLab returns `opened/closed`, the adapter folds
both into the common case. Every consumer handler became a near-mechanical
migration once `fetchIssue` landed.

### 7.3 When to choose hybrid

Pick hybrid over full-migration when at least one of these is true:
- The same narrow sub-call is needed by ≥2 handlers (see `fetchIssue` —
  10 consumers; `fetchPrState` — 2 consumers).
- The handler has non-platform orchestration >100 LoC (markdown parsing,
  polling loop, artifact walker, idempotent find-or-create) that would
  be duplicated into both platform adapters if lifted.
- The platform call is a <30 LoC kernel within a >200 LoC handler body.

Otherwise, prefer full-migration (simpler: one method, one pair of
adapter files, handler shrinks to ~50 LoC).

---

## 8. Testing

### 8.1 Subprocess-boundary mocks

Adapter tests mock at the `child_process` boundary — NOT at the adapter
module itself. Each `<method>-<platform>.ts` imports `execSync` from
`child_process` explicitly so tests can intercept with `mock.module`:

```ts
// lib/adapters/<method>-<platform>.test.ts
mock.module('child_process', () => ({
  execSync: (cmd: string) => { /* return canned stdout or throw */ },
}));
const { fooGithub } = await import('./foo-github.ts');
```

Mocking at the subprocess boundary means tests exercise the REAL adapter
code — the argv construction, response parsing, error normalization,
asymmetry detection. Tests that mock the adapter function itself test
nothing real and are rejected in review.

### 8.2 Mock pollution pitfall — `lesson_bun_mock_pollution.md`

`mock.module` is process-global last-write-wins in Bun. In a colocated
test suite where sibling files both mock `child_process`, the order of
discovery determines which mock wins. The codebase convention (56 files)
isolates each test by installing its own mock BEFORE `await import`ing
the adapter under test. If you see a test passing in isolation but
failing when the full suite runs, suspect this first.

### 8.3 Contract test (R-04)

`lib/adapters/types.test.ts` enforces two invariants at runtime:

1. Every method in `PLATFORM_ADAPTER_METHODS` is a function on both
   `githubAdapter` and `gitlabAdapter`. TypeScript type assertions can be
   `as`-cast-lied-about; the runtime probe cannot.
2. Methods NOT in `MIGRATED_METHODS` return the stub shape
   (`{ platform_unsupported: true, hint: 'not yet migrated' }`). Methods
   IN that set are exempt — they have real implementations.

When your migration lands, append your method name to `MIGRATED_METHODS`
(with a dated comment pointing at the story / issue number — see
`types.test.ts:40-88` for the established convention).

### 8.4 IT preservation

Each handler keeps its handler-level integration test (`handlers/<h>.test.ts`)
alongside the new adapter-level unit tests. Handler ITs run through the
REAL adapter (no mocks at the handler layer), mocking only at the
subprocess boundary. This catches wiring bugs the unit tests miss: e.g.
"adapter returns `{ platform_unsupported }` but the handler forgot to
branch on that arm."

### 8.5 Argv strictness — `lesson_origin_ops_pitfalls.md`

Test stubs MUST fail loudly on wrong argv, not silently pass through.
The gh-vs-glab argv asymmetries are easy to get wrong:

- `gh` accepts `--jq`, bare 6-char hex color (no leading `#`), and
  `--repo <slug>`.
- `glab` accepts NONE of those: no `--jq` flag; labels require
  `#RRGGBB`; the repo flag is `-R <slug>`.

A test that asserts `execSync` was called with an argv containing `-R`
will PASS on a GitHub adapter that (wrongly) passes `-R` — because
`execSync` is mocked. Instead, the stub should inspect the argv and
throw if it doesn't match the platform's expected shape:

```ts
mock.module('child_process', () => ({
  execSync: (cmd: string) => {
    if (cmd.startsWith('gh ') && cmd.includes(' -R ')) {
      throw new Error('gh does not accept -R; use --repo');
    }
    // ... canned response
  },
}));
```

This catches argv-confusion bugs that slip past pure argv-equality checks.

---

## 9. Cross-reference

- **Dev Spec:** `docs/platform-adapter-retrofit-devspec.md` — the authoritative
  requirements (R-01 through R-17), wave plan, and DoD. Section §5 covers
  the architecture; §5.4 defines the dispatch model; §5.5 enumerates the
  hybrid sub-call pattern.
- **VRTM (Vertical Retrofit Traceability Matrix):** referenced by the Dev
  Spec §9 — maps each requirement (R-NN) to its implementing story and
  acceptance evidence.
- **Phase 1 Survey:** `docs/adapters/survey.md` — classifies every handler
  as full-migration or hybrid; proposes sub-call signatures; lays out the
  Phase 2 wave plan. Read this before adding a new hybrid sub-call;
  chances are the shape was considered already.
- **Runtime types:** `lib/adapters/types.ts` — the living contract. This
  document paraphrases the types; the file itself is the source of truth.
- **Contract test:** `lib/adapters/types.test.ts` — runtime enforcement of
  interface completeness on both adapters.
- **Gate script:** `scripts/ci/gate-greps.sh` — R-09 / R-10 enforcement.
- **Memory pointers (learned lessons):**
  - `lesson_origin_ops_pitfalls.md` — gh-vs-glab argv asymmetries;
    test stubs must fail loudly on wrong argv.
  - `lesson_bun_mock_pollution.md` — `mock.module` is process-global
    last-write-wins; install your own mock before `await import`.
  - `lesson_mcp_binary_staleness.md` — MCP behavior disagrees with source?
    Suspect stale binary first.
