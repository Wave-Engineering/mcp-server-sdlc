<!-- DEV-SPEC-APPROVAL
approved: true
approved_by: BJ
approved_at: 2026-04-25T21:43:22Z
finalization_score: 7/7
-->

# Platform Adapter Retrofit — Development Specification

**Version:** 1.0
**Date:** 2026-04-25
**Status:** Draft
**Authors:** bakerb, tachikoma 🕷️ (cc-workflow), rules-lawyer 📜 (cc-workflow)

---

## Table of Contents

1. [Problem Domain](#1-problem-domain)
2. [Constraints](#2-constraints)
3. [Requirements (EARS Format)](#3-requirements-ears-format)
4. [Concept of Operations](#4-concept-of-operations)
5. [Detailed Design](#5-detailed-design)
   - [5.A Deliverables Manifest](#5a-deliverables-manifest)
   - [5.B Installation & Deployment](#5b-installation--deployment)
   - [5.N Open Questions](#5n-open-questions)
6. [Test Plan](#6-test-plan)
7. [Definition of Done](#7-definition-of-done)
   - [7.2 Dev Spec Finalization Checklist](#72-dev-spec-finalization-checklist)
8. [Phased Implementation Plan](#8-phased-implementation-plan)
9. [Appendices](#9-appendices)

---

## 1. Problem Domain

### 1.1 Background

`mcp-server-sdlc` is a dual-platform (GitHub + GitLab) MCP server with 73 handlers spanning PR/MR ops, CI ops, label/work-item CRUD, spec parsing, wave-state coordination, DDD/DoD verification, and flight planning. Of these, **31 handlers (~6,727 lines, 42% of the server's surface)** are platform-aware — they branch behavior based on `detectPlatform()` returning `'github'` or `'gitlab'`. Today's pattern is inline `if (platform === 'github') { ... } else { ... }` blocks within each handler. A partial GitLab helper exists at `lib/glab.ts` (post-hoc grab-bag of CLI wrappers) with no counterpart `lib/github.ts`. The current convention is documented in `docs/handlers/origin-operations-guide.md` §2.4, which explicitly prescribes per-handler duplication ("the 10-line cost of duplication is acceptable").

### 1.2 Problem Statement

The per-handler duplication convention was correct for Wave-1 parallel breadth (rapid feature additions) but is now the dominant maintenance tax. Five concrete failure modes today:

1. **Silent platform asymmetries** — `pr_merge.ts`'s `skip_train` parameter is silently ignored on GitLab (`mergeGitlab()` doesn't reference it). The handler accepts an argument it can't honor.
2. **Inconsistent subprocess invocation** — `execSync('gh ...')` in some, `lib/glab.ts` wrappers in others, `Bun.spawnSync` in `pr_create.ts`. Test mocks for one don't catch the other.
3. **Implicit normalization fallthroughs** — `pr_status.ts` line 218 has `mr.pipeline?.status ?? mr.head_pipeline?.status` — if both are undefined, CI state is silently lost.
4. **Per-handler format quirks** — `label_create.ts` strips `#` on lookup, prepends on create; `gh` and `glab` disagree on color format. Lazy maintenance corrupts silently.
5. **Maintenance cost is exponential, not linear** — every cross-cutting policy change (uniform error envelope, new logging field, contract refinement) requires a 31-handler sweep.

The deeper structural issue: agents reason about one method on one platform at a time, but every change requires loading a 339-line file that interleaves both platforms. The natural unit of agent work is "fix `pr_merge` on GitHub" — that should be ~80 lines of context, not 339.

### 1.3 Proposed Solution

**Per-method-per-platform adapter pattern** with a typed `PlatformAdapter` contract and `AdapterResult<T>` discriminated union (including `platform_unsupported: true` as a typed case, not an error). Adapter implementations live in flat-hyphenated `lib/adapters/<method>-<platform>.ts` files. Handlers shrink to ~50 lines (validation + dispatch via `lib/adapters/route.ts`). Migration is **strangler fig** — per-method-pair, one issue at a time, old inline path deleted as the adapter goes live, tests verify cutover. Migration order leads with the `pr_*` cluster (highest-leak, fresh context from #225, exemplar value of `platform_unsupported`).

### 1.4 Target Users

| Persona | Description | Primary Use Case |
|---------|-------------|------------------|
| **Agent (sdlc-server consumer)** | Claude Code workflow skills (`/precheck`, `/scp`, `/scpmmr`, `/nextwave`) and other MCP clients that invoke sdlc-server tools | Calling tools like `pr_merge`, `pr_status`, `ci_wait_run` and reasoning about responses. The retrofit gives them a typed `platform_unsupported` signal instead of silent ignores. |
| **Maintainer (human + agent)** | BJ, tachikoma, rules-lawyer, and future agents extending the server | Adding a new platform-aware method, fixing a platform-specific bug, or auditing how a method behaves on both platforms. The retrofit drops per-change context cost ~6×. |
| **Test author** | Anyone writing or modifying tests for platform-aware code | Today: archaeology to figure out "does GitLab support this?" The typed interface answers that mechanically. |

### 1.5 Non-Goals

- **Not a behavior change.** No tool's external semantics shift. Same inputs, same outputs from `pr_merge`, `pr_status`, etc. All 1378 existing tests must pass post-retrofit.
- **Not a feature addition.** New tools or capabilities (e.g., `pr_merge_wait` from #225) are explicitly separate work — they may be added during the retrofit window but they are not part of the retrofit's scope.
- **Not a subprocess-style normalization.** Migrating `Bun.spawnSync` in `pr_create.ts` to `execSync` (or vice versa) is a **pre-work decoupling** — a small, mechanical issue that lands before adapter migration starts. Not bundled in.
- **Not a sync-to-async migration.** If a code path uses `execSync` today, it stays `execSync` in the adapter unless an adapter method's contract is intrinsically async (e.g., `pr_wait_ci`).
- **Not a deletion of platform-agnostic code.** The 58% non-platform-aware handlers (`wave_*` state-only, `ddd_*`, `dod_*`, `devspec_*`, `drift_*`, `flight_*`, `campaign_*`, `spec_parser`, `dependency_graph`, `wave_state`) stay where they are.

---

## 2. Constraints

### 2.1 Technical Constraints

| ID | Constraint | Rationale |
|----|-----------|-----------|
| CT-01 | All 73 tool external interfaces (name + input schema + output shape) must remain backward-compatible | Per §1.5 non-goal "not a behavior change". sdlc-server is consumed by cc-workflow skills; breaking changes ripple. |
| CT-02 | TypeScript `strict` mode must catch missing implementations at compile time | The `AdapterResult<T>` discriminated union is the load-bearing safety net. Compile-time enforcement replaces "memory files reminding agents not to forget." |
| CT-03 | Must run on existing Bun runtime; no runtime swap | The MCP server is shipped as a single binary via `bun build --compile`. Changing runtime is out of scope. |
| CT-04 | Test mocks must be at the subprocess boundary | Per `lesson_origin_ops_pitfalls.md`. Higher-level mocking masks gh/glab argv differences (e.g., `gh` accepts `--jq`, `glab` does not). |
| CT-05 | Zero direct subprocess invocations (`execSync('gh ...')`, `execSync('glab ...')`, `Bun.spawnSync(...)`) in `handlers/` post-retrofit | Grep gate. Without this, the contract is theater. |
| CT-06 | `lib/glab.ts` utility helpers (`parseRepoSlug`, `detectPlatform`, etc.) move to `lib/shared/`; CLI invocation logic moves to GitLab adapter files; **GitLab response-type interfaces (`GitlabIssue`, `GitlabMr`, `GitlabPipeline`, `GitlabRepo`, `GitlabLabel`, `GitlabAssignee`) move to `lib/adapters/gitlab-types.ts`** for shared import by GitLab adapter files | Distinguishes platform-CLI behavior from platform-agnostic helpers from platform-specific shared types. |

### 2.2 Product Constraints

| ID | Constraint | Rationale |
|----|-----------|-----------|
| CP-01 | Strangler-fig migration: each method-pair lands as an independent PR | Big-bang is unreviewable; strangler-fig is parallelizable across waves and gives the commutativity-verifier STRONG verdicts. |
| CP-02 | Migration order leads with the `pr_*` cluster | Highest-leak handlers, fresh context from #225, exemplar value (`skip_train` → `platform_unsupported`) proves the architecture. |
| CP-03 | Subprocess-style normalization (`Bun.spawnSync` → `execSync` in `pr_create.ts`) lands as **pre-work** before adapter migration starts | Mechanical, small, decoupled — should not be conflated with adapter design. |
| CP-04 | Versioning: end-of-retrofit release is **v1.8.0** (minor bump) | AC mandates no external behavior change, so semver minor is honest. v2.0.0 reserved for actual breaking tool contract changes. |
| CP-05 | No coordinated changes to cc-workflow's skills required during the retrofit | The retrofit is internal architecture. Skills consume tools; they don't see the adapter layer. |

---

## 3. Requirements (EARS Format)

### 3.1 Contract & Types

| ID | Type | Requirement |
|----|------|-------------|
| R-01 | Ubiquitous | The system shall expose `PlatformAdapter` interface in `lib/adapters/types.ts` with one method per platform-aware tool. |
| R-02 | Ubiquitous | The system shall define `AdapterResult<T>` as a discriminated union with three variants: `{ok: true, data: T}`, `{ok: false, error: string, code: string}`, and `{platform_unsupported: true, hint: string}`. |
| R-03 | Unwanted | If an adapter method is called on a platform that does not support the underlying concept (e.g., `skip_train` on GitLab), then the adapter shall return `{platform_unsupported: true, hint: <message>}` instead of throwing or silently ignoring the parameter. |
| R-04 | Ubiquitous | The system shall enforce — via TypeScript `strict` mode and a contract test in `lib/adapters/types.test.ts` — that every method in `PlatformAdapter` has both a GitHub and a GitLab implementation (or explicitly returns `platform_unsupported`). |

### 3.2 Architecture & File Layout

| ID | Type | Requirement |
|----|------|-------------|
| R-05 | Ubiquitous | The system shall define adapter implementations as flat-hyphenated per-method-per-platform files at `lib/adapters/<method>-<platform>.ts`. No nested directories. |
| R-06 | Ubiquitous | The system shall route platform dispatch through a single `getAdapter()` function in `lib/adapters/route.ts`, invoked from each handler. |
| R-07 | Where | Where a handler is **hybrid** (mostly platform-agnostic with localized platform-specific sub-calls — e.g., `wave_compute`, `wave_init`, `dod_load_manifest`), the system shall extract only the platform-specific sub-call into the adapter; the handler retains its shared logic. |
| R-08 | Ubiquitous | The system shall provide `lib/adapters/index.ts` as the public surface for handlers to import. |

### 3.3 Cutover Gates

| ID | Type | Requirement |
|----|------|-------------|
| R-09 | Unwanted | If a handler in `handlers/` contains an `if (platform === 'github')`, `if (platform === 'gitlab')`, or equivalent inline platform-branching block post-retrofit, then the gate-grep shall fail. |
| R-10 | Unwanted | If a handler in `handlers/` invokes `execSync('gh ...')`, `execSync('glab ...')`, or `Bun.spawnSync(...)` directly post-retrofit, then the gate-grep shall fail. |
| R-11 | Ubiquitous | The system shall preserve all 73 tool names, input schemas, and output shapes; all existing tests must pass. |

### 3.4 Pre-Work Decoupling

| ID | Type | Requirement |
|----|------|-------------|
| R-12 | Ubiquitous | The system shall normalize subprocess invocation style — replacing `Bun.spawnSync` in `pr_create.ts` with `execSync` to match the project's standard — as a pre-work issue before adapter migration begins. |

### 3.5 Documentation & Discoverability

| ID | Type | Requirement |
|----|------|-------------|
| R-13 | Ubiquitous | The system shall provide `docs/adapters/README.md` documenting the contract, file layout, `platform_unsupported` discriminator, and the "where to add a new method" workflow. |
| R-14 | Ubiquitous | The system shall rewrite `docs/handlers/origin-operations-guide.md` §2.4 to reflect the new convention, preserving the prior rationale as historical context with a "superseded by adapter retrofit on `<date>`" note. |
| R-15 | Ubiquitous | Each `<method>-<platform>.ts` adapter file shall have a colocated `<method>-<platform>.test.ts` with subprocess-boundary mocks (per `lesson_origin_ops_pitfalls.md`'s argv-strictness convention). |

### 3.6 lib/glab.ts Disposition

| ID | Type | Requirement |
|----|------|-------------|
| R-16 | Ubiquitous | The system shall move all GitLab CLI invocations out of `lib/glab.ts` into per-method GitLab adapter files. |
| R-17 | Where | Where `lib/glab.ts` contains genuinely platform-agnostic helpers (`parseRepoSlug`, `detectPlatform`, error normalization), the system shall move them to `lib/shared/<helper>.ts` and delete the original location. |

---

## 4. Concept of Operations

### 4.1 System Context

```
                                    ┌──────────────────────────┐
                                    │   MCP Client (Claude)    │
                                    └───────────┬──────────────┘
                                                │ JSON-RPC over stdio
                                                ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                    sdlc-server (Bun binary)                   │
        │                                                               │
        │   ┌──────────────┐      ┌──────────────┐    ┌──────────────┐  │
        │   │  handlers/   │      │ lib/adapters │    │  lib/shared  │  │
        │   │  pr_merge.ts │─────▶│   route.ts   │    │ detectPlat() │  │
        │   │   (~50 ln)   │      │              │    │ parseSlug()  │  │
        │   └──────────────┘      │ getAdapter() │    └──────────────┘  │
        │                         └──────┬───────┘                      │
        │                                ▼                              │
        │                    ┌─────────────────────┐                    │
        │                    │  PlatformAdapter    │                    │
        │                    │ (typed interface)   │                    │
        │                    └──────────┬──────────┘                    │
        │            ┌──────────────────┴──────────────────┐            │
        │            ▼                                     ▼            │
        │  lib/adapters/                          lib/adapters/         │
        │  pr-merge-github.ts                     pr-merge-gitlab.ts    │
        │   (~80 lines)                            (~80 lines)          │
        │            │                                     │            │
        └────────────┼─────────────────────────────────────┼────────────┘
                     ▼                                     ▼
              ┌──────────────┐                    ┌──────────────┐
              │  gh CLI      │                    │  glab CLI    │
              └──────┬───────┘                    └──────┬───────┘
                     ▼                                   ▼
              GitHub REST/GraphQL                 GitLab REST API v4
```

The adapter layer is the platform boundary. Handlers don't know what platform they're talking to. Subprocess invocation is exclusively in adapter files.

### 4.2 Runtime Dispatch Flow

1. MCP client invokes a tool (e.g., `pr_merge({number: 42})`)
2. `index.ts` validates input via Zod schema, dispatches to the handler's `execute()`
3. Handler calls `const adapter = await getAdapter({repo: args.repo})` — `route.ts` invokes `detectPlatform()` from `lib/shared/`, returns either `githubAdapter` or `gitlabAdapter`
4. Handler calls the typed method: `const result = await adapter.prMerge(args)`
5. Adapter shells out to `gh` or `glab` (or makes a direct API call), normalizes the response into `AdapterResult<PrMergeResponse>`
6. Handler wraps the result in the MCP response envelope and returns

### 4.3 Migration Flow (per method-pair, strangler-fig)

For each of the 31 platform-aware methods, one wave story executes:

1. Add the method signature to `PlatformAdapter` in `lib/adapters/types.ts`
2. Create `lib/adapters/<method>-github.ts` — lift GitHub logic from the handler verbatim, refactor to return `AdapterResult<T>`
3. Create `lib/adapters/<method>-gitlab.ts` — lift GitLab logic, refactor to return `AdapterResult<T>` (or `platform_unsupported` for asymmetric features)
4. Refactor `handlers/<method>.ts` to ~50 lines of validation + `getAdapter().<method>(args)` dispatch
5. Move handler's existing tests to colocated `<method>-<platform>.test.ts` adapter test files (subprocess-boundary mocks)
6. Add the contract-test entry in `lib/adapters/types.test.ts` that asserts both implementations exist
7. CI gate-greps run: `if (platform === 'github')` must return zero matches in the touched handler; direct `execSync('gh ...')`/`execSync('glab ...')` must return zero matches in the touched handler
8. Existing pre-retrofit tool-level integration tests must still pass (no behavior change)
9. Merge via `/scpmmr` — exactly one method-pair per PR

Each method-pair PR touches disjoint files (different `<method>-github.ts`, different handler), so the commutativity-verifier returns STRONG and parallel flights are safe.

### 4.4 `platform_unsupported` Surfacing Flow

Canonical example: `skip_train: true` on GitLab — GitLab has merge trains but they're auto-managed, no explicit skip.

1. Handler receives the call, validates the schema (Zod accepts the field — schema is platform-agnostic)
2. Handler dispatches via `adapter.prMerge(args)`
3. GitLab adapter checks: `if (args.skip_train === true) return { platform_unsupported: true, hint: 'merge trains are auto-managed by GitLab; skip_train is GitHub-merge-queue-only' }`
4. Handler returns `{ok: true, platform_unsupported: true, hint: '...'}` to the MCP envelope
5. Caller receives a typed signal — not a silent ignore (today's bug), not an error (overreaction)

This is the contract that today's pattern silently violates. TypeScript's exhaustiveness check makes it impossible to miss the case in adapter code.

---

## 5. Detailed Design

### 5.1 The `PlatformAdapter` Interface

The interface lives in `lib/adapters/types.ts`. One method per platform-aware tool. Methods grouped by tool family for readability.

```typescript
// lib/adapters/types.ts

export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string }
  | { platform_unsupported: true; hint: string };

export interface PlatformAdapter {
  // PR/MR operations
  prCreate(args: PrCreateArgs): Promise<AdapterResult<PrCreateResponse>>;
  prMerge(args: PrMergeArgs): Promise<AdapterResult<PrMergeResponse>>;
  prMergeWait(args: PrMergeWaitArgs): Promise<AdapterResult<PrMergeWaitResponse>>;
  prStatus(args: PrStatusArgs): Promise<AdapterResult<PrStatusResponse>>;
  prDiff(args: PrDiffArgs): Promise<AdapterResult<PrDiffResponse>>;
  prComment(args: PrCommentArgs): Promise<AdapterResult<PrCommentResponse>>;
  prFiles(args: PrFilesArgs): Promise<AdapterResult<PrFilesResponse>>;
  prList(args: PrListArgs): Promise<AdapterResult<PrListResponse>>;
  prWaitCi(args: PrWaitCiArgs): Promise<AdapterResult<PrWaitCiResponse>>;

  // CI operations
  ciWaitRun(args: CiWaitRunArgs): Promise<AdapterResult<CiWaitRunResponse>>;
  ciRunStatus(args: CiRunStatusArgs): Promise<AdapterResult<CiRunStatusResponse>>;
  ciRunLogs(args: CiRunLogsArgs): Promise<AdapterResult<CiRunLogsResponse>>;
  ciFailedJobs(args: CiFailedJobsArgs): Promise<AdapterResult<CiFailedJobsResponse>>;
  ciRunsForBranch(args: CiRunsForBranchArgs): Promise<AdapterResult<CiRunsForBranchResponse>>;

  // Label & issue CRUD
  labelCreate(args: LabelCreateArgs): Promise<AdapterResult<LabelCreateResponse>>;
  labelList(args: LabelListArgs): Promise<AdapterResult<LabelListResponse>>;
  workItem(args: WorkItemArgs): Promise<AdapterResult<WorkItemResponse>>;
  ibm(args: IbmArgs): Promise<AdapterResult<IbmResponse>>;
  epicSubIssues(args: EpicSubIssuesArgs): Promise<AdapterResult<EpicSubIssuesResponse>>;

  // Spec operations
  specGet(args: SpecGetArgs): Promise<AdapterResult<SpecGetResponse>>;
  specValidateStructure(args: SpecValidateStructureArgs): Promise<AdapterResult<SpecValidateStructureResponse>>;
  specAcceptanceCriteria(args: SpecAcceptanceCriteriaArgs): Promise<AdapterResult<SpecAcceptanceCriteriaResponse>>;
  specDependencies(args: SpecDependenciesArgs): Promise<AdapterResult<SpecDependenciesResponse>>;

  // Hybrid sub-calls — PLACEHOLDER. Final set determined by the Phase 1
  // survey deliverable (Story 1.12). Methods listed here are illustrative
  // examples of the pattern; the survey will produce the authoritative list.
  // Adding/removing sub-calls is expected during Phase 2 implementation.
  fetchIssue(args: FetchIssueArgs): Promise<AdapterResult<IssueData>>;
  // (others TBD per survey output)
}
```

### 5.2 The `AdapterResult<T>` Discriminated Union

Three variants, each with a distinct discriminator:

```typescript
export type AdapterResult<T> =
  | { ok: true; data: T }                                        // success
  | { ok: false; error: string; code: string }                   // runtime failure
  | { platform_unsupported: true; hint: string };                // structural asymmetry
```

**Why three variants, not two:**
- `ok: true` — success. Caller acts on `data`.
- `ok: false` — runtime failure (CLI exit non-zero, API rate-limited, permission denied, network error). Caller decides retry/escalate/surface-to-user.
- `platform_unsupported: true` — **structural** asymmetry. The platform doesn't have this concept. Caller treats this as a typed signal, not an error. (`skip_train` on GitLab; `merge_train_settings` on GitHub.)

Today's silent-ignore pattern collapses the third case into either "fake success" (the bug) or "error" (overreaction). The discriminated union forces it into the type system.

### 5.3 Directory Layout

```
lib/
├── adapters/
│   ├── types.ts                        # PlatformAdapter interface + AdapterResult<T>
│   ├── route.ts                        # getAdapter() dispatch
│   ├── index.ts                        # public re-exports
│   ├── github.ts                       # githubAdapter object — assembles all <method>-github.ts impls
│   ├── gitlab.ts                       # gitlabAdapter object — assembles all <method>-gitlab.ts impls
│   ├── pr-create-github.ts             ┐
│   ├── pr-create-gitlab.ts             │  PR family
│   ├── pr-merge-github.ts              │
│   ├── pr-merge-gitlab.ts              │
│   ├── ... (one pair per method)       ┘
│   ├── ci-wait-run-github.ts           ┐  CI family
│   ├── ci-wait-run-gitlab.ts           ┘
│   ├── label-create-github.ts          ┐  Label/issue family
│   ├── label-create-gitlab.ts          ┘
│   ├── ...
│   ├── fetch-issue-github.ts           ┐  Hybrid sub-calls
│   ├── fetch-issue-gitlab.ts           ┘
│   ├── gitlab-types.ts                 # GitlabIssue, GitlabMr, GitlabPipeline, etc. — shared by GitLab adapters
│   └── types.test.ts                   # contract test (R-04)
│
├── shared/
│   ├── detect-platform.ts              # moved from lib/glab.ts
│   ├── parse-repo-slug.ts              # moved from lib/glab.ts
│   ├── shell-escape.ts                 # extracted from pr_merge.ts
│   └── error-norm.ts                   # extracted ExecError handling
│
└── (existing platform-agnostic code unchanged)
    ├── wave_state.ts
    ├── spec_parser.ts
    ├── dependency_graph.ts
    ├── flight_overlap.ts
    ├── merge_queue_detect.ts           # already added in #225 — stays where it is
    └── pr_state.ts                     # already added in #225 — folds into fetch-pr-state-*.ts during retrofit
```

`lib/glab.ts` is **deleted** at the end of the retrofit (R-16 + R-17). All its content has either moved to `lib/adapters/<method>-gitlab.ts` (CLI invocations) or `lib/shared/` (utility helpers).

### 5.4 Dispatch Layer (`route.ts`)

```typescript
// lib/adapters/route.ts

import { detectPlatform } from '../shared/detect-platform.js';
import { githubAdapter } from './github.js';
import { gitlabAdapter } from './gitlab.js';
import type { PlatformAdapter } from './types.js';

export function getAdapter(args?: { repo?: string }): PlatformAdapter {
  const platform = detectPlatform(args);
  return platform === 'gitlab' ? gitlabAdapter : githubAdapter;
}
```

`detectPlatform()` resolves from `args.repo` if present (cross-repo support), falling back to the cwd's git remote. `getAdapter()` is sync because `detectPlatform()` is sync (current behavior preserved per CT-03).

The handler pattern becomes:

```typescript
// handlers/pr_merge.ts (post-retrofit, ~50 lines)
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/route.js';
import { wrapEnvelope } from '../lib/shared/envelope.js';

const inputSchema = z.object({
  number: z.number().int().positive(),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  repo: z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/).optional(),
});

const handler: HandlerDef = {
  name: 'pr_merge',
  description: '...',
  inputSchema,
  async execute(rawArgs) {
    const args = inputSchema.parse(rawArgs);
    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.prMerge(args);
    return wrapEnvelope(result);
  },
};

export default handler;
```

### 5.5 Hybrid Handler Pattern (R-07)

For handlers that are mostly platform-agnostic with localized platform-specific sub-calls — `wave_compute`, `wave_init`, `wave_finalize` (find-or-create idempotency: needs `findExistingPr` + `createPr` — TWO sub-calls), `wave_previous_merged`, `wave_reconcile_mrs`, `dod_load_manifest` — the migration extracts only the platform-specific operation(s), not the entire handler. Some hybrid handlers will need multiple sub-calls; the Phase 1 survey (Story 1.12) produces the authoritative list.

**Before (`handlers/wave_previous_merged.ts`):**
```typescript
const platform = detectPlatform();
const githubSlug = platform === 'github' ? parseRepoSlug() : null;
// ... 100 lines of state-aware logic ...
const info = platform === 'github'
  ? fetchGithubClosureInfo(issue.number, githubSlug as string)
  : fetchGitlabClosureInfo(issue.number);
// ... more state logic ...
```

**After:**
```typescript
const adapter = getAdapter({ repo: args.repo });
// ... state-aware logic unchanged ...
const closureResult = await adapter.fetchIssueClosure({ number: issue.number });
// ... rest of state-aware logic ...
```

`fetchIssueClosure` is a typed `PlatformAdapter` method with `<method>-github.ts` + `<method>-gitlab.ts` implementations. The handler's state-machine code stays put.

### 5.6 Migration Template (per method-pair)

Embedded in `docs/adapters/README.md` as the "where to add a new method" workflow:

1. **Add to interface** (`lib/adapters/types.ts`)
2. **Create GitHub adapter** (`lib/adapters/<method>-github.ts`) — lift logic, return `AdapterResult<T>`
3. **Create GitLab adapter** (`lib/adapters/<method>-gitlab.ts`) — lift logic, return `AdapterResult<T>` or `platform_unsupported`
4. **Wire into adapter assemblers** (`lib/adapters/github.ts`, `lib/adapters/gitlab.ts`)
5. **Migrate handler** (`handlers/<method>.ts`) — strip platform logic, dispatch via `getAdapter().<method>(args)`
6. **Move tests** — handler-level tests stay at the integration level; new unit tests colocated as `<method>-<platform>.test.ts`
7. **Run gate-greps** — verify zero `if (platform === 'github')`, zero `execSync('gh ...')`/`execSync('glab ...')` in the handler
8. **Run full suite** — all 1378+ tests pass
9. **Open PR via `/scpmmr`** — one method-pair per PR

### 5.7 Test Strategy Summary

Detail in Section 6.

- Adapter unit tests at the subprocess boundary (R-15)
- Contract test enforcing implementation completeness (R-04)
- Handler integration tests preserved unchanged (R-11)
- Gate-greps in CI (R-09, R-10)

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README.md | Docs | 1 | `README.md` | Phase 3 | required | Updated with adapter architecture section |
| DM-02 | Unified build system | Code | 1 | N/A — because Bun-native build via `package.json` scripts + `scripts/ci/validate.sh`; no Makefile needed | — | N/A | Bun convention |
| DM-03 | CI/CD pipeline + gate-greps | Code | 1 | `.github/workflows/ci.yml` (existing) + `scripts/ci/validate.sh` (gate-greps added) | Phase 1, Wave 1.2 | required | Two new gate-grep steps |
| DM-04 | Automated test suite | Test | 1 | `tests/` + `lib/adapters/*.test.ts` + `lib/adapters/types.test.ts` | Phase 1, Waves 1.2-1.6; Phase 2 | required | Per-method colocated tests |
| DM-05 | Test results (JUnit XML) | Test | 1 | N/A — because `bun test` reports to stdout only; JUnit XML reporter is a separate cross-cutting follow-up, not part of retrofit scope | — | N/A | Future enhancement |
| DM-06 | Coverage report | Test | 1 | N/A — because no coverage tooling is configured today; adding it is a separate cross-cutting follow-up, not part of retrofit scope | — | N/A | Future enhancement |
| DM-07 | CHANGELOG | Docs | 1 | GitHub release notes on tag (per Wave-Engineering convention) | Phase 3 | required | Established by v1.6.0/v1.7.0 |
| DM-08 | VRTM | Trace | 1 | Dev Spec Appendix V | Phase 3 (closing story) | required | Standard |
| DM-09 | Architecture/audience-facing docs | Docs | 1, 2 (architecture trigger fired) | `docs/adapters/README.md` (new), `docs/handlers/origin-operations-guide.md` §2.4 (rewritten), `docs/adapters/survey.md` (Phase 1 deliverable) | Phase 1, Wave 1.7 (survey); Phase 3 (others) | required | Architecture doc trigger fired (>2 components) |
| DM-10 | Manual test procedures document | Docs | 2 (MV-XX trigger fired) | `docs/platform-adapter-retrofit-devspec.md` §6.4 (inline) | Phase 1, Wave 1.8 (MV-01..04 execution); Phase 3 (MV-05, MV-06 execution) | required | Procedures defined inline in §6.4; executed in closing stories |

### 5.B Installation & Deployment

#### Local Installation

Existing `scripts/install-remote.sh` flow — unchanged. After Phase 3 release:

1. `curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-sdlc/main/scripts/install-remote.sh | SDLC_VERSION=v1.8.0 bash`
2. Restart Claude Code sessions (`/exit` + `claude --continue`)
3. New MCP server with adapter architecture is live

#### CI/CD Pipeline

| Stage | Trigger | Steps | Artifacts | Gate |
|-------|---------|-------|-----------|------|
| Validate | Every push | `bun test`, `tsc --noEmit`, `validate.sh` (incl. new gate-greps) | none | must pass to merge |
| Build | Merge to main | `bun build --compile` (per platform) | sdlc-server-{linux,darwin}-{x64,arm64} | must succeed |
| Release | Tag push (`v*`) | Existing release.yml workflow | GitHub release with binaries | manual approval (tag) |

#### Production / Release Deployment

Single-binary release on GitHub Releases. Consumers run `install-remote.sh` to pull. No server-side deployment.

### 5.N Open Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Where does `detectPlatform()` live? | `lib/shared/detect-platform.ts` (CT-06, R-17) |
| 2 | How are async boundaries handled? | Sync stays sync; adapter methods are `async` only when the underlying op is genuinely async (e.g., `pr_wait_ci` polls). Per CT-03 + non-goal "not a sync-to-async migration." |
| 3 | Do we need a `MockAdapter` for testing? | **No** for v1.8.0. Subprocess-boundary mocks (CT-04) are sufficient. Reconsider if contract tests grow unwieldy. |
| 4 | What happens to the `repo` arg's meaning? | Flows through `getAdapter({repo})` cleanly. Adapter methods receive `args.repo` and pass it to their CLI invocations. No special threading needed. |
| 5 | Backward compatibility window / dual-write phase? | **No dual-write.** Strangler-fig per method-pair (CP-01) provides the safety net. Each PR replaces one method's inline path; tests verify cutover; behavior unchanged. |
| 6 | Versioning (v1.6.0 vs v2.0.0)? | **v1.8.0** at retrofit completion (CP-04). Internal architecture; no external behavior change. |
| 7 | Hybrid handler sub-call granularity | **Deferred to Phase 1 survey deliverable** (Story 1.12). Phase 1 produces `docs/adapters/survey.md` mapping each of the 22 non-`pr_*` handlers to "full migration" or "hybrid + sub-calls X, Y, Z". The survey is the Phase 2 wave plan's input. Re-run `/devspec` post-survey to amend Section 8 with Phase 2 detail. |

---

## 6. Test Plan

### 6.1 Test Strategy

The retrofit must preserve all existing tool-level behavior — the 1378 existing tests are the primary regression guardrail. Three test layers:

- **Unit tests at the subprocess boundary** (per CT-04 and `lesson_origin_ops_pitfalls.md`): each `lib/adapters/<method>-<platform>.ts` has a colocated `<method>-<platform>.test.ts` that mocks `child_process.execSync` (or the appropriate subprocess primitive) and asserts (a) wire format of generated commands, (b) parsing of canonical CLI output, (c) error handling, (d) `platform_unsupported` returns. Stubs reject wrong-shape argv loudly to catch regressions.
- **Contract test** (`lib/adapters/types.test.ts`): iterates the `PlatformAdapter` interface keys and asserts both `githubAdapter` and `gitlabAdapter` have implementations (or explicitly return `platform_unsupported`). Fails compilation if a method is added to the interface without both impls.
- **Handler integration tests** (existing `tests/<handler>.test.ts`): preserved as-is. They mock `execSync` and verify the tool's external behavior. The retrofit must pass these without modification (R-11).

CI enforces two **gate-greps** in `scripts/ci/validate.sh`: zero `if (platform === 'github')`-style branches in `handlers/`, zero direct `execSync('gh ...')`/`execSync('glab ...')`/`Bun.spawnSync` calls in `handlers/`. Failing greps fail the build.

### 6.2 Integration Tests (Automated)

| ID | Boundary | Description | Req IDs |
|----|----------|-------------|---------|
| IT-01 | Handler → Adapter | Each migrated handler dispatches via `getAdapter().<method>(args)`; mock the adapter, assert handler passes through args + wraps the response in the MCP envelope | R-06 |
| IT-02 | Adapter → CLI subprocess | Each `<method>-<platform>.test.ts` mocks `execSync` and asserts the gh/glab invocation shape (argv, flags, repo flag) | R-05, R-15 |
| IT-03 | Contract — interface completeness | `lib/adapters/types.test.ts` iterates interface methods; fails if either GitHub or GitLab adapter is missing an implementation | R-04 |
| IT-04 | Pre-existing tool behavior preservation | Run all 1378 existing `tests/<handler>.test.ts` files post-retrofit; assert zero failures (no behavior change) | R-11 |
| IT-05 | Gate-grep in CI | `validate.sh` fails when platform-branching or direct subprocess calls exist in `handlers/` | R-09, R-10 |

### 6.3 End-to-End Tests (Automated)

The MCP server has no UI; "end-to-end" for this project means tool-call-through-to-CLI-output. The integration tests cover this. **No additional E2E test layer.**

### 6.4 Manual Verification Procedures

| ID | Procedure | Pass Criteria | Req IDs |
|----|-----------|---------------|---------|
| MV-01 | After Phase 1 ships: install v1.8.0-rc binary locally; from a Wave-Engineering GitHub repo, call `pr_status` on an open PR and `pr_list` for the repo via the running MCP. Compare responses byte-by-byte against the same calls on v1.7.0. | Responses identical (or differences are documented schema additions, not changes) | R-11 |
| MV-02 | After Phase 1 ships: from a GitLab project, call `pr_merge({number, skip_train: true})`. | Response shape includes `platform_unsupported: true` with hint mentioning merge trains; no error thrown; the merge does NOT proceed silently | R-03 |
| MV-03 | After Phase 1 ships: deliberately add an `if (platform === 'github')` block to a non-migrated handler in a feature branch; run `validate.sh`. | The gate-grep fails the validation run with a clear error message naming the file and line | R-09 |
| MV-04 | After Phase 1 ships: deliberately add `execSync('gh ...')` to a handler; run `validate.sh`. | Gate-grep fails with clear error | R-10 |
| MV-05 | After Phase 3 ships (retrofit complete): grep the entire `handlers/` tree for `if (platform === ` and direct `execSync('gh\|glab` patterns. | Zero matches | R-09, R-10 |
| MV-06 | After Phase 3 ships: install v1.8.0 final binary; full smoke test of `/precheck` workflow on this repo; full smoke test of `/scpmmr` workflow on a small PR. | Workflows complete without error; behavior matches v1.7.0 | R-11 |

---

## 7. Definition of Done

### 7.1 Global Definition of Done

- [ ] All Phase 1, Phase 2, Phase 3 DoD checklists are satisfied
- [ ] All Test Plan items (Section 6) executed and passed
- [ ] All deliverables from the Deliverables Manifest (Section 5.A) produced and verified
- [ ] All 17 requirements from Section 3 traced via VRTM (Appendix V)
- [ ] Zero `if (platform === 'github\|gitlab')` matches in `handlers/` tree (gate-grep) [R-09]
- [ ] Zero direct `execSync('gh\|glab ...')` or `Bun.spawnSync` matches in `handlers/` tree (gate-grep) [R-10]
- [ ] All 1378+ existing tool-level integration tests pass with no modification [R-11]
- [ ] `lib/glab.ts` is deleted [R-16]
- [ ] `docs/adapters/README.md` exists and documents the contract, file layout, and "where to add a method" workflow [R-13]
- [ ] `docs/handlers/origin-operations-guide.md` §2.4 is rewritten with supersession note [R-14]
- [ ] `v1.8.0` tagged and released
- [ ] cc-workflow's existing skills (`/scpmmr`, `/precheck`, `/nextwave`, etc.) work unchanged against v1.8.0 (smoke verified per MV-06)

### 7.2 Dev Spec Finalization Checklist

- [x] Every Tier 1 row in the Deliverables Manifest (5.A) has a file path or "N/A — because [reason]"
- [x] Every Tier 2 trigger that fires has a corresponding row in the Deliverables Manifest (architecture doc trigger fired → DM-09)
- [⚠️] Every Deliverables Manifest row has a "Produced In" wave assignment — **Phase 1 rows have wave assignments; Phase 2/3 rows have phase-only assignments pending detailed plans (per CP-01 strangler-fig with Phase 1 survey deliverable). This is intentional and called out in Section 8.**
- [x] Every MV-XX in Section 6.4 has a procedure document — they're inline in this Dev Spec; no separate doc needed
- [x] No deliverable is referenced only as a verb without a corresponding noun (file path)
- [x] At least one audience-facing doc (DM-09) has a file path assigned (`docs/adapters/README.md`, `docs/adapters/survey.md`)
- [x] Section 7 Definition of Done references the Deliverables Manifest

---

## 8. Phased Implementation Plan

### How to read this section

**Phases map to Epics.** Each Phase is a major milestone with its own Definition of Done checklist.

**User Stories map to Issues.** Each story becomes a single issue in the project tracker. Stories contain step-by-step implementation instructions and an Acceptance Criteria checklist.

**Waves enable parallel development.** Stories are grouped into Waves — sets of stories with no inter-dependencies that can execute simultaneously.

**Requirement traceability.** Each AC item is annotated with the requirement ID(s) it verifies — e.g., `[R-01]`.

**One story, one repo.** All stories in this Dev Spec target `Wave-Engineering/mcp-server-sdlc`.

### Wave Map

```
PHASE 1 — Framework, canary, and survey
─────────────────────────────────────────
Wave 1.1  ─── Story 1.1: Subprocess style normalization (pre-work)
                  │
Wave 1.2  ─── Story 1.2: Adapter scaffold + lib/shared/ extractions
                  │
Wave 1.3  ─┬─ Story 1.3: Migrate pr_create
            ├─ Story 1.4: Migrate pr_diff           (4 parallel — disjoint files)
            ├─ Story 1.5: Migrate pr_files
            └─ Story 1.6: Migrate pr_list
                  │
Wave 1.4  ─┬─ Story 1.7: Migrate pr_status
            ├─ Story 1.8: Migrate pr_comment        (3 parallel — disjoint files)
            └─ Story 1.9: Migrate pr_wait_ci
                  │
Wave 1.5  ─── Story 1.10: Migrate pr_merge
                  │
Wave 1.6  ─── Story 1.11: Migrate pr_merge_wait    (depends on Story 1.10)
                  │
Wave 1.7  ─── Story 1.12: Phase 1 survey (docs/adapters/survey.md)
                  │
Wave 1.8  ─── Story 1.13: Phase 1 closing — manual verification (MV-01 through MV-04)

PHASE 2 — Migrate remaining 22 handlers (TBD pending Phase 1 survey)
PHASE 3 — Cleanup, docs, release (outline below; refined post-Phase 2)
```

| Wave | Stories | Master Issue | Parallel? |
|------|---------|-------------|-----------|
| 1.1 | 1.1 | Story 1.1 | Single story |
| 1.2 | 1.2 | Story 1.2 | Single story (foundational) |
| 1.3 | 1.3, 1.4, 1.5, 1.6 | Wave 1.3 Master | Yes — 4 parallel |
| 1.4 | 1.7, 1.8, 1.9 | Wave 1.4 Master | Yes — 3 parallel |
| 1.5 | 1.10 | Story 1.10 | Single story |
| 1.6 | 1.11 | Story 1.11 | Single story |
| 1.7 | 1.12 | Story 1.12 | Single story |
| 1.8 | 1.13 | Story 1.13 | Single story (closing) |

### Co-production Rule

Each method-pair migration story produces a deployable change to the binary. Verification procedures (MV-01 through MV-04) execute in Wave 1.8 (Phase 1 closing), not deferred to Phase 3. MV-05 and MV-06 are Phase 3 final gates.

---

### Phase 1: Framework, Canary, and Survey (Epic)

**Goal:** Validate the adapter architecture on the highest-leak handler cluster, ship the gate-greps that prevent regression, and produce the survey that informs Phase 2 wave planning.

#### Phase 1 Definition of Done

- [ ] `lib/adapters/types.ts` defines `PlatformAdapter` interface + `AdapterResult<T>` discriminated type [R-01, R-02]
- [ ] `lib/adapters/route.ts` provides `getAdapter()` dispatch [R-06]
- [ ] `lib/adapters/index.ts` exports the public surface [R-08]
- [ ] `lib/adapters/types.test.ts` contract test passes [R-04]
- [ ] All 9 `pr_*` methods migrated; their handler files are ≤80 lines and contain no platform branching or direct subprocess calls [R-05, R-09, R-10]
- [ ] Gate-greps in `scripts/ci/validate.sh` fire on intentionally-bad branches (per MV-03, MV-04) [R-09, R-10]
- [ ] `docs/adapters/survey.md` exists and classifies each of the 22 remaining handlers as full-migration or hybrid + sub-calls
- [ ] All existing 1378+ tests pass [R-11]
- [ ] MV-01 through MV-04 executed and recorded

---

#### Story 1.1: Pre-work — Normalize subprocess invocation style

**Wave:** 1.1
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** None

`pr_create.ts` uses `Bun.spawnSync` (anomalous — every other handler uses `execSync` from `child_process`). Normalize to `execSync` so test mocks at the subprocess boundary work uniformly post-retrofit.

**Implementation Steps:**
1. Read `handlers/pr_create.ts` lines 35-51 (the `Bun.spawnSync` block)
2. Refactor to `execSync` with the same args + output parsing
3. Update `tests/pr_create.test.ts` mocks to use the existing `mock.module('child_process', ...)` pattern (matches `pr_merge.test.ts`)
4. Run full suite — all tests pass

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr_create — execSync invocation matches gh CLI shape` | Argv assertion at boundary | `tests/pr_create.test.ts` |

*Integration/E2E Coverage:*
- IT-04 — pre-existing tests preserved

**Acceptance Criteria:**

- [ ] `grep -n "Bun.spawnSync" handlers/` returns zero matches [R-12]
- [ ] `tests/pr_create.test.ts` uses `mock.module('child_process', ...)` pattern
- [ ] Full suite passes (1378+ tests)
- [ ] No external behavior change to `pr_create` tool

---

#### Story 1.2: Build adapter scaffold + extract lib/shared/

**Wave:** 1.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.1

Build the `lib/adapters/` skeleton with empty implementations + extract platform-agnostic helpers from `lib/glab.ts` into `lib/shared/`. Add gate-greps to CI.

**Implementation Steps:**
1. Create `lib/adapters/types.ts` per Section 5.1 — full `PlatformAdapter` interface (with placeholder hybrid sub-calls per Section 5.1); `AdapterResult<T>` discriminated union
2. Create `lib/adapters/route.ts` with `getAdapter()` per Section 5.4
3. Create `lib/adapters/github.ts` and `lib/adapters/gitlab.ts` as empty assemblers (object literals with all methods returning `{platform_unsupported: true, hint: 'not yet migrated'}`)
4. Create `lib/adapters/index.ts` re-exporting `getAdapter`, `PlatformAdapter`, `AdapterResult`
5. Create `lib/adapters/types.test.ts` with the contract test (iterates interface methods, asserts both adapters implement)
6. Move `parseRepoSlug`, `detectPlatform`, related helpers from `lib/glab.ts` to `lib/shared/parse-repo-slug.ts` and `lib/shared/detect-platform.ts` [R-17]
7. Update all importers of moved helpers to point at new locations
8. Add two **scoped** gate-greps to `scripts/ci/validate.sh` with an EXCLUDE-list mechanism — the grep runs against `handlers/` MINUS the handlers listed in `scripts/ci/migration-allowlist.txt` (which is initialized with all 31 platform-aware handlers excluded — i.e., gate not yet enforced for them). The grep IS enforced for any handler NOT in the allowlist:
   - Create `scripts/ci/migration-allowlist.txt` with the 31 platform-aware handler basenames (one per line) — these are the handlers EXEMPT from the gate-grep until they're migrated
   - Add to `scripts/ci/validate.sh`: build the file list as `handlers/*.ts` minus everything in the allowlist; run two greps against the resulting list; fail if either matches:
     - `if (platform === '(github|gitlab)')` — inline platform branching
     - `execSync\('(gh|glab)|Bun\.spawnSync` — direct subprocess in handler
   - Each migration story (Story 1.3 onward) REMOVES its handler from `migration-allowlist.txt` as part of its AC
   - Phase 3 closing story (Story 3.6) verifies the allowlist file is empty (or deletes it entirely, hard-enforcing the grep on all handlers)
9. Confirm contract test passes (vacuously — every method returns `platform_unsupported`, no real impls yet)
10. Confirm gate-grep mechanism works on a known-clean handler (e.g., a non-platform-aware handler like `wave_show.ts`): deliberately add a violating line, run `validate.sh`, see the failure; revert

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `PlatformAdapter contract — every method has GitHub impl` | R-04 enforcement | `lib/adapters/types.test.ts` |
| `PlatformAdapter contract — every method has GitLab impl` | R-04 enforcement | `lib/adapters/types.test.ts` |
| `getAdapter returns github for github URL` | Dispatch correctness | `lib/adapters/route.test.ts` |
| `getAdapter returns gitlab for gitlab URL` | Dispatch correctness | `lib/adapters/route.test.ts` |
| `parseRepoSlug works from new location` | Helper move regression | `lib/shared/parse-repo-slug.test.ts` |

*Integration/E2E Coverage:*
- IT-03 — contract test ✓
- IT-05 — gate-greps in CI ✓
- IT-04 — preserved

**Acceptance Criteria:**

- [ ] `lib/adapters/types.ts` defines `PlatformAdapter` + `AdapterResult<T>` [R-01, R-02]
- [ ] `lib/adapters/route.ts:getAdapter()` exists and dispatches correctly [R-06]
- [ ] `lib/adapters/index.ts` exports public surface [R-08]
- [ ] `lib/adapters/types.test.ts` passes (contract test) [R-04]
- [ ] `lib/shared/{parse-repo-slug.ts, detect-platform.ts}` exist and are importable [R-17]
- [ ] `lib/glab.ts` no longer exports `parseRepoSlug` or `detectPlatform` (they re-export from new location for transition; final deletion in Phase 3)
- [ ] `scripts/ci/migration-allowlist.txt` exists with the 31 platform-aware handler basenames listed
- [ ] Gate-grep #1 (`if (platform === ...)`) added to `validate.sh` with EXCLUDE-list scoping
- [ ] Gate-grep #2 (subprocess in handler) added to `validate.sh` with EXCLUDE-list scoping
- [ ] Manual sanity check: deliberately add a violating line to a non-platform-aware handler (e.g., `wave_show.ts`), confirm `validate.sh` fails; revert
- [ ] Full suite passes (1378+ tests)

---

#### Stories 1.3–1.9: Canary `pr_*` migrations (parallel waves)

Each follows the migration template (Section 5.6).

**Story body template:**
> **Migrate `pr_<method>` to `lib/adapters/pr-<method>-{github,gitlab}.ts`**
>
> Implement `prMethod()` in `PlatformAdapter`. Lift GitHub logic from `handlers/pr_<method>.ts` into `lib/adapters/pr-<method>-github.ts`; lift GitLab logic into `lib/adapters/pr-<method>-gitlab.ts`. Refactor handler to ~50-line dispatch. Move tests to colocated adapter test files.

**Acceptance Criteria template (per story):**
- [ ] `lib/adapters/pr-<method>-github.ts` exists; returns `AdapterResult<PrMethodResponse>` [R-05]
- [ ] `lib/adapters/pr-<method>-gitlab.ts` exists; returns `AdapterResult<PrMethodResponse>` (or `platform_unsupported` for asymmetric features) [R-05, R-03]
- [ ] `handlers/pr_<method>.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Colocated tests: `lib/adapters/pr-<method>-github.test.ts` + `lib/adapters/pr-<method>-gitlab.test.ts` [R-15]
- [ ] Existing `tests/pr_<method>.test.ts` integration tests pass unchanged [R-11]
- [ ] **`pr_<method>.ts` removed from `scripts/ci/migration-allowlist.txt`** — gate-grep now enforces against this handler
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes

**Wave assignments:**
- Wave 1.3: Stories 1.3 (`pr_create`), 1.4 (`pr_diff`), 1.5 (`pr_files`), 1.6 (`pr_list`) — 4 parallel
- Wave 1.4: Stories 1.7 (`pr_status`), 1.8 (`pr_comment`), 1.9 (`pr_wait_ci`) — 3 parallel

---

#### Story 1.10: Migrate `pr_merge`

**Wave:** 1.5
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Same template. Critical: this handler is the most-recent contributor of leak inventory (`skip_train` silent ignore on GitLab). The GitLab adapter MUST return `platform_unsupported` for `skip_train: true`.

**Additional acceptance criteria:**
- [ ] `lib/adapters/pr-merge-gitlab.ts:prMerge` returns `{platform_unsupported: true, hint: 'merge trains are auto-managed by GitLab; skip_train is GitHub-merge-queue-only'}` when `args.skip_train === true` [R-03]
- [ ] Standard template ACs above

---

#### Story 1.11: Migrate `pr_merge_wait`

**Wave:** 1.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.10

`pr_merge_wait` currently imports `performMerge` from `pr_merge.ts`. After Story 1.10, that import goes away — `pr_merge_wait` calls `getAdapter().prMerge(args)` directly via the migration.

**Additional acceptance criteria:**
- [ ] `handlers/pr_merge_wait.ts` no longer imports `performMerge` from `pr_merge.ts`
- [ ] Polling logic (`pollUntilMerged`) stays as a `lib/` module — it's platform-agnostic
- [ ] **Migrate `lib/pr_state.ts` to adapter pair**: create `lib/adapters/fetch-pr-state-github.ts` + `lib/adapters/fetch-pr-state-gitlab.ts`; refactor `lib/pr_state.ts` to delegate to them (or delete + update importers); `lib/pr_state.ts` itself contains zero direct subprocess calls post-story (closes the gap that `lib/pr_state.ts` is in `lib/`, not `handlers/`, so the gate-grep won't catch its subprocess calls) [R-10 spirit]
- [ ] Standard template ACs

---

#### Story 1.12: Phase 1 Survey deliverable

**Wave:** 1.7
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Stories 1.3–1.11

Write `docs/adapters/survey.md` — the input to Phase 2 wave planning.

**Implementation Steps:**
1. For each of the 22 remaining platform-aware handlers (all of `ci_*`, `label_*`, `work_item`, `ibm`, `epic_sub_issues`, `spec_*`, `wave_*` platform-aware members, `dod_load_manifest`):
   - Read the handler in full
   - Classify: **full migration** (entirely platform-specific) OR **hybrid** (mostly shared, localized sub-calls)
   - For hybrid: list the sub-call methods needed (e.g., `fetchIssue`, `fetchPrState`, `fetchIssueClosure`)
2. Aggregate sub-calls across all hybrid handlers — produce the final `PlatformAdapter` sub-call list
3. Identify file-overlap structure that informs wave grouping (e.g., handlers sharing the same hybrid sub-call should likely be in adjacent waves)
4. Recommend Phase 2 wave count and rough story groupings (this is the recommendation, not the binding plan — `/devspec` re-run will produce binding plan)
5. Write to `docs/adapters/survey.md`

**Acceptance Criteria:**
- [ ] `docs/adapters/survey.md` exists
- [ ] All 22 handlers classified
- [ ] Sub-call aggregation complete
- [ ] Phase 2 wave count + grouping recommendation present

---

#### Story 1.13: Phase 1 Closing — Manual Verification

**Wave:** 1.8
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.12

Execute MV-01 through MV-04. File any bugs as separate issues. Update Phase 1 DoD checklist.

**Acceptance Criteria:**
- [ ] MV-01 executed; outputs identical to v1.7.0
- [ ] MV-02 executed; `platform_unsupported` returned for `skip_train` on GitLab
- [ ] MV-03 executed; gate-grep fires on intentionally-bad branch
- [ ] MV-04 executed; gate-grep fires on direct subprocess call
- [ ] Bug issues filed for any failures
- [ ] Phase 1 DoD checklist updated and reviewed

---

### Phase 2: Migrate remaining 22 handlers (TBD)

**Status:** Plan deferred pending Phase 1 survey output (Story 1.12). Re-run `/devspec` after Phase 1 closes to amend this section with detailed wave plan and stories.

**Anticipated structure** (informational only — NOT binding):
- Multiple waves grouped by handler family (CI, label/issue, spec, wave-*) and by hybrid sub-call sharing
- Each story = one method-pair migration (same template as Phase 1 canaries)
- Every story carries the standard template AC: handler ≤80 lines, gate-greps pass, contract test passes

**Phase 2 DoD** (will firm up post-survey):
- [ ] All 22 remaining platform-aware handlers migrated
- [ ] All hybrid sub-calls implemented for both platforms
- [ ] Zero gate-grep matches in `handlers/`
- [ ] `lib/glab.ts` retains only re-export shims (full deletion in Phase 3)

---

### Phase 3: Cleanup, docs, release (outline)

**Status:** Outline-only. Refined post-Phase 2.

**Anticipated stories:**
- Story 3.1: Delete `lib/glab.ts` (verify zero importers) [R-16]
- Story 3.2: Rewrite `docs/handlers/origin-operations-guide.md` §2.4 with supersession note [R-14]
- Story 3.3: Write `docs/adapters/README.md` — contract docs + "where to add a method" workflow [R-13]
- Story 3.4: Update root `README.md` with adapter architecture section
- Story 3.5: Tag and release v1.8.0
- Story 3.6: Phase 3 closing — execute MV-05 + MV-06; complete VRTM (Appendix V)

**Phase 3 DoD** (preliminary):
- [ ] `lib/glab.ts` deleted
- [ ] All docs updated per R-13, R-14
- [ ] v1.8.0 tagged + released
- [ ] MV-05, MV-06 executed and recorded
- [ ] VRTM complete in Appendix V
- [ ] All 17 requirements have at least one verification entry
- [ ] `scripts/ci/migration-allowlist.txt` is empty or deleted (gate-greps now enforce against ALL handlers globally)

---

## 9. Appendices

### Appendix A: Cross-references

- **`docs/sketches/platform-adapter-retrofit.md`** — the design sketch this Dev Spec formalizes (PR #227)
- **`docs/handlers/origin-operations-guide.md` §2.4** — the convention this retrofit supersedes
- **Memory: `lesson_origin_ops_pitfalls.md`** — gh/glab CLI divergences + test-stub strictness
- **Memory: `lesson_merge_queue_pattern.md`** — pr_merge eager response + queue enforcement
- **Memory: `lesson_wave_state_python_writer.md`** — wave_state schema-ownership boundary (relevant for Phase 2 hybrid handler migrations)
- **Issue #227** — draft PR carrying the original sketch
- **Issue #225 (closed)** — v1.7.0 pr_merge aggregate response work; informs canary cluster context

### Appendix V: Verification Requirements Traceability Matrix (VRTM)

*Populated at Phase 3 closing. Skeleton:*

| Req ID | Requirement (short) | Source | Verification Item | Verification Method | Status |
|--------|---------------------|--------|-------------------|---------------------|--------|
| R-01 | PlatformAdapter interface | Story 1.2 | Story 1.2 AC: types.ts exists | unit test (types.test.ts) + inspection | Pending |
| R-02 | AdapterResult discriminated type | Story 1.2 | Story 1.2 AC: types.ts defines | unit test | Pending |
| R-03 | platform_unsupported variant returned for asymmetric features | Story 1.10 (canary), Phase 2 hybrid stories | Story 1.10 AC + MV-02 | unit test + manual | Pending |
| R-04 | Contract test enforces both impls | Story 1.2 | IT-03 | contract unit test | Pending |
| R-05 | Flat-hyphenated file layout | Stories 1.3-1.11, Phase 2 | Per-story AC | inspection + grep | Pending |
| R-06 | route.ts dispatches | Story 1.2 | Story 1.2 AC | unit test | Pending |
| R-07 | Hybrid handler pattern | Phase 2 (hybrid stories) | Per-story AC, post-survey | inspection | Pending |
| R-08 | Public index.ts | Story 1.2 | Story 1.2 AC | inspection | Pending |
| R-09 | Zero inline platform branching | Stories 1.3-1.11, Phase 2, Phase 3 | IT-05, MV-03, MV-05 | gate-grep + manual | Pending |
| R-10 | Zero direct subprocess in handlers | Stories 1.3-1.11, Phase 2, Phase 3 | IT-05, MV-04, MV-05 | gate-grep + manual | Pending |
| R-11 | Backward-compatible behavior | All migration stories | IT-04, MV-01, MV-06 | regression suite + manual | Pending |
| R-12 | Subprocess style normalized | Story 1.1 | Story 1.1 AC | inspection + test | Pending |
| R-13 | docs/adapters/README.md exists | Phase 3 Story 3.3 | Story 3.3 AC | inspection | Pending |
| R-14 | §2.4 rewritten with supersession | Phase 3 Story 3.2 | Story 3.2 AC | inspection | Pending |
| R-15 | Colocated adapter test files | All migration stories | Per-story AC | inspection + suite run | Pending |
| R-16 | lib/glab.ts deleted | Phase 3 Story 3.1 | Story 3.1 AC | inspection (file absent) | Pending |
| R-17 | Helpers moved to lib/shared/ | Story 1.2 + Phase 3 cleanup | Story 1.2 AC + final inspection | inspection | Pending |
