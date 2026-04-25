---
title: Platform Adapter Retrofit
status: draft
audience: tachikoma 🕷️ (cc-workflow)
sketched-by: rules-lawyer 📜 + BJ
sketched: 2026-04-25
supersedes: docs/handlers/origin-operations-guide.md §2.4 ("Why per-handler duplication (no `lib/platform.ts`)")
---

# Platform Adapter Retrofit — Sketch

## TL;DR

The 31 platform-aware handlers in `handlers/` (42% of the server's surface, ~6,700 lines) currently inline `if (platform === 'github') { ... } else { ... }` branching. A partial adapter exists at `lib/glab.ts` but no counterpart `lib/github.ts`, and the existing design doc (§2.4 of `origin-operations-guide.md`) explicitly *prescribes* per-handler duplication as the convention.

That convention was correct for "Wave-1 parallel burst" (rapid breadth) but is now the dominant maintenance tax. We're retrofitting a **per-method-per-platform adapter pattern** with a typed contract and a thin dispatch layer. The shape is optimized for two non-traditional constraints:

1. **AI-native maintainability.** Every adapter file fits in a single tool-call's worth of context. An agent can read, modify, and test one file without paging in 500 surrounding lines.
2. **Wave-pattern parallelism.** Each method-platform pair is a single file. Two flights touching different methods touch disjoint files. Commutativity-verifier returns STRONG without effort.

Both fall out of one structural decision: **flat-hyphenated per-method-per-platform files** (e.g., `lib/adapters/pr-merge-github.ts`, `lib/adapters/pr-merge-gitlab.ts`).

This sketch is the design intent and the evidence base. **Decomposition into wave-pattern issues is explicitly the implementer's call** — we trust your read of file overlap and dependency ordering more than ours.

---

## Why now

### 1. The current pattern is a known-broken contract

The existing inline-branching pattern produces **silent platform asymmetries** that survive review. Today's leak inventory (from the platform-fork survey, 2026-04-25):

- **`pr_merge.ts`'s `skip_train` parameter is silently ignored on GitLab** (`mergeGitlab()` lines 284–304 don't reference it). The handler accepts an argument it can't honor on one of the two platforms it claims to support. Tests cover GitHub-only.
- **`wave_ci_trust_level.ts` checks GitHub branch-protection rulesets but only a boolean `merge_trains_enabled` flag on GitLab** (lines 27–127). The trust model is structurally unequal.
- **Shell-out patterns are inconsistent:** `execSync('gh ...')` direct in some handlers, `lib/glab.ts` wrappers in others, `Bun.spawnSync` in `pr_create.ts` (lines 35–51). Test mocks for `execSync` don't catch `Bun.spawnSync` paths.
- **GitLab pipeline status normalization is implicit:** `pr_status.ts` line 218 does `mr.pipeline?.status ?? mr.head_pipeline?.status`. If both are `undefined`, `aggregateGitlabPipeline(undefined)` silently returns `summary: 'none'` — losing CI state. GitHub path is explicit (`gh pr checks --json`).
- **Label color handling forks per-handler:** `label_create.ts` strips `#` on lookup, prepends `#` on create. Format conventions differ between `gh` (bare hex) and `glab` (with `#`). One getting lazy could cause silent corruption.

These aren't sloppy implementation; they're the predictable consequence of a per-handler duplication policy with no enforcing contract.

### 2. The maintenance cost is exponential, not linear

Per `origin-operations-guide.md` §2.4: *"The 10-line cost of duplication is acceptable."* That was true at 5 handlers. At 31 handlers, the cost compounds:

- Every cross-cutting policy change (e.g., uniform error envelope, new logging field, `platform_unsupported` discriminator) requires a 31-handler sweep.
- Every new handler is two implementations + tests for both, at the same level of polish — a latency tax on adding capability.
- Every memory-of-incident lesson (e.g., `lesson_merge_queue_gh.md`) lives in agent memory but cannot be enforced against the code, because the code has no boundary that says "GitHub-specific".
- Every drift between GitHub and GitLab semantics (merge queue vs merge train, rulesets vs approval rules) leaks into handler bodies as if-else gates, and the discriminating logic accumulates *inside* the handler instead of at a contract boundary.

### 3. The cleaner half is the asset we don't want to duplicate

The 58% of handlers that are platform-agnostic — `wave_*` state machine, `ddd_*`, `dod_*`, `devspec_*`, `drift_*`, `flight_*`, `spec_parser`, `dependency_graph`, `wave_state` — are the genuinely valuable abstractions. They don't care about platform and they shouldn't be forced into a fork. Splitting the server into `-github` + `-gitlab` repos would duplicate them for no gain. Adapter retrofit lets them stay where they are while we fix the platform-aware 42%.

### 4. AI-native maintainability is a real constraint

Every agent that touches `pr_merge.ts` today has to read 339 lines to find the GitHub path. Most of that is GitLab logic they don't care about. The reverse is true for a GitLab-targeted change. With per-method-per-platform files, an agent's context surface for "fix GitHub merge-queue handling in `pr_merge`" is ~80 lines of GitHub adapter + ~50 lines of types + ~30 lines of dispatch. That's 4× cheaper to load and reason about, every single time.

This isn't a stylistic preference. It's the natural unit of agent work, and it's worth optimizing for.

---

## Target architecture

### Directory layout

```
lib/
├── adapters/
│   ├── types.ts                    # PlatformAdapter interface + return types
│   ├── route.ts                    # detectPlatform() → routes to right impl
│   ├── index.ts                    # public surface
│   ├── pr-create-github.ts
│   ├── pr-create-gitlab.ts
│   ├── pr-merge-github.ts
│   ├── pr-merge-gitlab.ts
│   ├── pr-status-github.ts
│   ├── pr-status-gitlab.ts
│   ├── ci-wait-run-github.ts
│   ├── ci-wait-run-gitlab.ts
│   ├── label-create-github.ts
│   ├── label-create-gitlab.ts
│   ├── ...
│   └── (one pair per method)
├── shared/
│   ├── repo-slug.ts                # truly platform-agnostic helpers
│   ├── error-norm.ts
│   └── ...
└── (existing platform-agnostic code: wave_state.ts, spec_parser.ts, dependency_graph.ts unchanged)
```

### Why flat-hyphenated, not nested

`lib/adapters/pr-merge-github.ts` rather than `lib/adapters/github/pr-merge.ts`.

Reasoning:
- `ls lib/adapters/pr-merge-*` shows both implementations side-by-side.
- The natural unit of inquiry is "how does pr-merge work on both platforms?" — flat keeps that comparison cheap.
- Memory file naming maps one-to-one: `lesson_pr-merge-github_optimistic_merged_true.md` → `lib/adapters/pr-merge-github.ts`. Bug references become file paths.
- Grep-friendly: `grep -l '...' lib/adapters/*-github.ts` is one platform; `*-gitlab.ts` is the other.

The nested-directory alternative wins for "what does GitHub support?" inquiries, but those are rarer and answerable via the interface in `types.ts` anyway.

### Contract shape (sketch — finalize during /devspec)

```ts
// lib/adapters/types.ts

export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string }
  | { platform_unsupported: true; hint: string };

export interface PlatformAdapter {
  prCreate(args: PrCreateArgs): Promise<AdapterResult<PrCreateResponse>>;
  prMerge(args: PrMergeArgs): Promise<AdapterResult<PrMergeResponse>>;
  prStatus(args: PrStatusArgs): Promise<AdapterResult<PrStatusResponse>>;
  prDiff(args: PrDiffArgs): Promise<AdapterResult<PrDiffResponse>>;
  prComment(args: PrCommentArgs): Promise<AdapterResult<PrCommentResponse>>;
  prFiles(args: PrFilesArgs): Promise<AdapterResult<PrFilesResponse>>;
  prList(args: PrListArgs): Promise<AdapterResult<PrListResponse>>;
  prWaitCi(args: PrWaitCiArgs): Promise<AdapterResult<PrWaitCiResponse>>;

  ciWaitRun(args: CiWaitRunArgs): Promise<AdapterResult<CiWaitRunResponse>>;
  ciRunStatus(args: CiRunStatusArgs): Promise<AdapterResult<CiRunStatusResponse>>;
  ciRunLogs(args: CiRunLogsArgs): Promise<AdapterResult<CiRunLogsResponse>>;
  ciFailedJobs(args: CiFailedJobsArgs): Promise<AdapterResult<CiFailedJobsResponse>>;
  ciRunsForBranch(args: CiRunsForBranchArgs): Promise<AdapterResult<CiRunsForBranchResponse>>;

  labelCreate(args: LabelCreateArgs): Promise<AdapterResult<LabelCreateResponse>>;
  labelList(args: LabelListArgs): Promise<AdapterResult<LabelListResponse>>;

  workItem(args: WorkItemArgs): Promise<AdapterResult<WorkItemResponse>>;
  ibm(args: IbmArgs): Promise<AdapterResult<IbmResponse>>;
  epicSubIssues(args: EpicSubIssuesArgs): Promise<AdapterResult<EpicSubIssuesResponse>>;

  specGet(args: SpecGetArgs): Promise<AdapterResult<SpecGetResponse>>;
  specValidateStructure(args: SpecValidateStructureArgs): Promise<AdapterResult<SpecValidateStructureResponse>>;
  specAcceptanceCriteria(args: SpecAcceptanceCriteriaArgs): Promise<AdapterResult<SpecAcceptanceCriteriaResponse>>;
  specDependencies(args: SpecDependenciesArgs): Promise<AdapterResult<SpecDependenciesResponse>>;

  // wave_* methods that ARE platform-aware (e.g. wave_finalize opens a kahuna→main MR via pr_create-equivalent)
  // — sub-list to be enumerated during /devspec; some wave_* are state-only and stay in lib/wave_state.ts
}
```

The discriminated `AdapterResult<T>` is the load-bearing piece:

- `ok: true` — success.
- `ok: false` — runtime failure (e.g., CLI exit non-zero, API rate-limited, permission denied). Caller decides retry/escalate.
- `platform_unsupported: true` — **structural** asymmetry. The platform doesn't have this concept (e.g., `skip_train` on GitLab). Caller treats this as a typed signal, not an error.

`platform_unsupported` is the contract that today's pattern silently violates. Making it a discriminated case forces the asymmetry into the type system — TypeScript won't compile if a handler ignores the case.

### Dispatch layer

```ts
// lib/adapters/route.ts

import { detectPlatform } from '../glab';  // reuse existing detection during transition
import { githubAdapter } from './github';
import { gitlabAdapter } from './gitlab';

export async function getAdapter(args: { repo?: string }): Promise<PlatformAdapter> {
  const platform = await detectPlatform(args);
  return platform === 'gitlab' ? gitlabAdapter : githubAdapter;
}
```

Each handler becomes:

```ts
// handlers/pr_merge.ts (post-retrofit)

export const prMerge: HandlerDef = {
  name: 'pr_merge',
  schema: { /* input/output */ },
  async execute(args) {
    const adapter = await getAdapter(args);
    return adapter.prMerge(args);
  },
};
```

Handlers stop containing platform logic. They're orchestrators of validation + dispatch. The platform fork lives in adapter files, behind a typed boundary.

### What stays out of `lib/adapters/`

The 58% platform-agnostic surface stays exactly where it is:

- `lib/wave_state.ts`, `lib/spec_parser.ts`, `lib/dependency_graph.ts` — no change.
- `handlers/wave_*` (state-only: `wave_show`, `wave_defer`, `wave_complete`, `wave_planning`, `wave_preflight`, `wave_review`, `wave_waiting`, `wave_flight*`) — no change.
- `handlers/ddd_*`, `handlers/dod_*`, `handlers/devspec_*`, `handlers/drift_*`, `handlers/flight_*`, `handlers/campaign_*` — no change.

The retrofit's blast radius is bounded to the platform-aware 31 handlers + `lib/glab.ts` (which gets reorganized into per-method-per-platform files).

---

## The 31 handlers in scope

| # | Handler | Lines | Notes |
|---|---|---|---|
| 1 | `ci_wait_run.ts` | 569 | merge-queue special case lives here |
| 2 | `wave_finalize.ts` | 509 | opens kahuna→main MR; uses pr-create-equivalent |
| 3 | `wave_init.ts` | 450 | issue fetch is platform-aware; state mutation is shared |
| 4 | `pr_wait_ci.ts` | 406 | broken on local gh CLI per `lesson_pr_wait_ci_broken.md` |
| 5 | `pr_create.ts` | 357 | uses `Bun.spawnSync` (anomalous) |
| 6 | `wave_compute.ts` | 353 | dependency-graph + platform-aware issue fetch |
| 7 | `pr_merge.ts` | 339 | `skip_train` leak; aggregate-response work in sdlc#225 |
| 8 | `ci_run_status.ts` | 306 | |
| 9 | `wave_previous_merged.ts` | 278 | bug sdlc#223 here |
| 10 | `pr_status.ts` | 268 | GitLab pipeline-status implicit fallthrough |
| 11 | `wave_reconcile_mrs.ts` | 239 | |
| 12 | `wave_topology.ts` | 234 | |
| 13 | `label_create.ts` | 213 | label color format quirks |
| 14 | `dod_load_manifest.ts` | 213 | |
| 15 | `wave_dependency_graph.ts` | 212 | |
| 16 | `ci_run_logs.ts` | 210 | |
| 17 | `epic_sub_issues.ts` | 207 | |
| 18 | `pr_files.ts` | 182 | |
| 19 | `ci_runs_for_branch.ts` | 178 | |
| 20 | `wave_ci_trust_level.ts` | 174 | merge-train detection here |
| 21 | `pr_diff.ts` | 171 | |
| 22 | `ibm.ts` | 166 | |
| 23 | `spec_dependencies.ts` | 161 | |
| 24 | `ci_failed_jobs.ts` | 161 | |
| 25 | `pr_comment.ts` | 159 | |
| 26 | `pr_list.ts` | 135 | |
| 27 | `spec_validate_structure.ts` | 126 | |
| 28 | `work_item.ts` | 124 | cross-platform issue/PR creation |
| 29 | `spec_get.ts` | 112 | |
| 30 | `label_list.ts` | 108 | |
| 31 | `spec_acceptance_criteria.ts` | 107 | |

**Total:** 6,727 lines of platform-aware handler code. After retrofit, expect:
- ~50 lines per handler (validation + dispatch only) → ~1,500 lines total in handlers
- ~5,200 lines distributed across ~62 adapter files (31 methods × 2 platforms), avg ~80 lines per file
- Net code volume roughly the same. Net **per-file context window cost** drops by ~6×.

---

## Acceptance criteria — epic level

The retrofit is complete when:

- [ ] `lib/adapters/types.ts` defines `PlatformAdapter` interface + `AdapterResult<T>` discriminated type with `platform_unsupported` case.
- [ ] `lib/adapters/route.ts` exists; detection logic moved out of individual handlers.
- [ ] `lib/adapters/index.ts` exports the public surface.
- [ ] Every method in the interface has both `<method>-github.ts` and `<method>-gitlab.ts` files implementing it. No nested directories.
- [ ] **Zero `if (platform === 'github')` blocks remain in `handlers/`.** Grep returns nothing.
- [ ] **Zero direct `execSync('gh ...')` or `execSync('glab ...')` calls remain in `handlers/`.** Shell-out is exclusively in adapter files.
- [ ] `lib/adapters/types.test.ts` is a contract test that, for every method in the interface, asserts both GitHub and GitLab adapters either implement it or return `platform_unsupported`. New methods added to the interface MUST update this test or fail compilation.
- [ ] Each `<method>-<platform>.ts` has a colocated `<method>-<platform>.test.ts`. Test mocks are at the subprocess boundary (per `lesson_origin_ops_pitfalls.md`); stubs reject wrong-shape argv.
- [ ] `lib/glab.ts` is either deleted (functionality moved into adapters) or reduced to a thin shim documenting deprecation. The post-hoc grab-bag is gone.
- [ ] `pr_create.ts`'s anomalous `Bun.spawnSync` use is normalized to the project's standard `execSync` (or vice versa — pick one and apply it everywhere).
- [ ] `skip_train: true` on GitLab returns `{platform_unsupported: true, hint: "merge trains are auto-managed by GitLab; skip_train is GitHub-merge-queue-only"}` — not an error, not silently ignored.
- [ ] `docs/handlers/origin-operations-guide.md` §2.4 is rewritten to reflect the new convention. The "per-handler duplication" rationale is preserved as historical context with a note that it was superseded by this retrofit on `<date>`.
- [ ] `docs/adapters/README.md` (new) documents the contract, the file layout, the `platform_unsupported` discriminator, and the "where to add a new method" workflow.
- [ ] All existing tool-level integration tests (the 77 in `tests/`) pass post-retrofit. No external behavior change.
- [ ] sdlc#218 (probe install + `PROBE_UNAVAILABLE`), sdlc#223 (`wave_previous_merged` deferral handling), sdlc#225 (`pr_merge` aggregate response) — these can land independently before, during, or after the retrofit. They're orthogonal.

---

## Decomposition is yours

We've deliberately not pre-filed wave-pattern issues. Reasons:

1. **You'll spot the file-overlap structure faster than we will.** Some of the 31 methods share helpers (URL parsing, error normalization). You'll know which extractions belong in `lib/shared/` vs which should stay duplicated. We're guessing.
2. **You may want a transitional double-write phase** (call both old inline path and new adapter, compare outputs) for the load-bearing handlers like `pr_merge`. Or you may not. That's an implementation strategy call.
3. **The 31 handlers are not equally complex.** `spec_acceptance_criteria` (107 lines) is mostly structural validation. `ci_wait_run` (569 lines) has merge-queue special cases. Those probably want different decompositions — single issue vs subdivided.
4. **Wave-pattern partitioning depends on dependency ordering.** `pr_*` adapter changes likely affect `wave_finalize` (which opens an MR via something pr_create-shaped). You'll see those dependencies live; we'd guess them.

Suggested macro-shape (NOT prescriptive):

- **Phase 1:** Define `types.ts` + `route.ts` + `index.ts` skeleton. Land empty adapters that return `platform_unsupported` for everything. Contract test passes vacuously. (1 issue, must-be-first.)
- **Phase 2:** Migrate methods, ordered by your judgment of priority. Probably the `pr_*` cluster first because that's where the leaks are most active. Each method is one issue ≈ one wave story; pairs of `<method>-github` and `<method>-gitlab` get implemented together.
- **Phase 3:** Delete `lib/glab.ts`'s grab-bag, rewrite §2.4 of `origin-operations-guide.md`, write `docs/adapters/README.md`. (1-3 issues.)

This shape is what BJ and rules-lawyer sketched in conversation. Use it, ignore it, or replace it — whichever serves the work.

---

## Open design questions for /devspec

Things we deliberately didn't decide here. You should resolve them when you formalize this into a Dev Spec:

1. **Where does `detectPlatform()` live post-retrofit?** Today in `lib/glab.ts`. Probably wants to move to `lib/adapters/route.ts` so the adapter is self-contained. Or to `lib/shared/detect-platform.ts` if other code (tests, other libs) needs it.

2. **How are async boundaries handled?** Today some shell-outs are sync (`execSync`), some async (`gitlabApiMr` is async). Adapter methods are typed `async` — does that force all current sync calls to migrate to `Bun.spawn` or a wrapper? Probably yes, but it has perf implications worth measuring.

3. **Do we need a `MockAdapter` for testing?** Could be cleaner than mocking subprocess for some test scenarios (e.g., contract tests, integration tests of higher-level flows). Or could be over-engineering.

4. **What happens to the `repo` argument's meaning?** Today some handlers accept `repo: 'owner/name'` for cross-repo operations. Does that flow through `getAdapter()` cleanly, or does it need to be threaded explicitly?

5. **Backward compatibility window.** The retrofit is a refactor; external behavior shouldn't change. But sdlc-server is consumed by cc-workflow's skills. Do you want a feature-flagged dual-path during migration (call both, compare, alert on divergence)? Or hard cutover per handler? Latency cost vs. confidence cost trade-off.

6. **Versioning.** Does this go out as v1.6.0 (alongside the kahuna tools that haven't been released yet) or v2.0.0 (as a clear "breaking-internal-architecture, no caller change required" major bump)? Internal architecture so 1.6.0 is defensible, but 2.0.0 is more honest about the surface volume.

Don't try to answer these in a Dev Spec preamble — let them surface as you implement and document the resolutions in the Dev Spec proper.

---

## Cross-references

- **`origin-operations-guide.md` §2.4** — the convention this sketch supersedes. Read before writing the Dev Spec to know what argument we're explicitly walking away from.
- **`lib/glab.ts`** — the post-hoc partial adapter. Most of this gets either renamed-and-relocated into per-method GitLab adapter files or extracted into `lib/shared/`.
- **`lesson_origin_ops_pitfalls.md`** (memory) — stub-argv strictness conventions.
- **`lesson_merge_queue_gh.md`** (memory) — merge-queue specific behavior, relevant to `pr-merge-github.ts` design.
- **`lesson_pr_wait_ci_broken.md`** (memory) — `pr-wait-ci-github.ts` will inherit this constraint.
- **`decision_skills_ownership.md`** (memory) — clarifies that skills (cc-workflow) consume MCP tools (sdlc-server). The boundary is one-way; this retrofit doesn't affect skills.
- **sdlc#218** (probe install + `PROBE_UNAVAILABLE`) — orthogonal; lands independently.
- **sdlc#223** (`wave_previous_merged` deferral handling) — orthogonal; the bug is logical, not architectural.
- **sdlc#225** (`pr_merge` aggregate response + `pr_merge_wait`) — touches `pr-merge-github.ts` and `pr-merge-gitlab.ts`. Coordinate sequencing: probably easier to land #225 *first* (in the current architecture) and then migrate the result of that work into the adapter, rather than fight a moving target.

---

## How to pick this up

1. Read this sketch. Push back on anything that doesn't make sense; the design intent should be defendable, not blindly executed.
2. Run `/devspec` (or whatever the current entry point is) to formalize. The Dev Spec is where you resolve the open design questions above and produce something issue-decomposable.
3. `/prepwaves` against the Dev Spec. Decide your wave structure based on what you actually see in the code.
4. `/wavemachine` once the proving-ground decision unblocks Tier 3 autonomy on cc-workflow side. Until then, `/nextwave` interactive is fine — the retrofit is large but each issue is mechanical, so the human-in-loop cost is minimal.

You're operating with full design authority on the implementation. The architecture is in this sketch. The decomposition is yours. Welcome to the lake.

— **rules-lawyer** 📜 (cc-workflow), 2026-04-25
