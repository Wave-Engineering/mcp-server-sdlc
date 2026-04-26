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
| DM-01 | README.md | Docs | 1 | `README.md` | Phase 3, Wave 3.3 (Story 3.4) | required | Updated with adapter architecture section |
| DM-02 | Unified build system | Code | 1 | N/A — because Bun-native build via `package.json` scripts + `scripts/ci/validate.sh`; no Makefile needed | — | N/A | Bun convention |
| DM-03 | CI/CD pipeline + gate-greps | Code | 1 | `.github/workflows/ci.yml` (existing) + `scripts/ci/validate.sh` (gate-greps added) | Phase 1, Wave 1.2 | required | Two new gate-grep steps |
| DM-04 | Automated test suite | Test | 1 | `tests/` + `lib/adapters/*.test.ts` + `lib/adapters/types.test.ts` | Phase 1, Waves 1.2–1.8 (landed); Phase 2, Waves 2.0–2.6 (per-story additions); Phase 3, Waves 3.1–3.5 | required | Per-method colocated tests |
| DM-05 | Test results (JUnit XML) | Test | 1 | N/A — because `bun test` reports to stdout only; JUnit XML reporter is a separate cross-cutting follow-up, not part of retrofit scope | — | N/A | Future enhancement |
| DM-06 | Coverage report | Test | 1 | N/A — because no coverage tooling is configured today; adding it is a separate cross-cutting follow-up, not part of retrofit scope | — | N/A | Future enhancement |
| DM-07 | CHANGELOG | Docs | 1 | GitHub release notes on tag (per Wave-Engineering convention) | Phase 3, Wave 3.4 (Story 3.5) | required | Established by v1.6.0/v1.7.0; v1.8.0 notes written in Story 3.5 |
| DM-08 | VRTM | Trace | 1 | Dev Spec Appendix V | Phase 3, Wave 3.5 (Story 3.6) | required | Populated in closing story |
| DM-09 | Architecture/audience-facing docs | Docs | 1, 2 (architecture trigger fired) | `docs/adapters/README.md` (new, Story 3.3), `docs/handlers/origin-operations-guide.md` §2.4 (rewritten, Story 3.2), `docs/adapters/survey.md` (Phase 1 deliverable, shipped) | Phase 1, Wave 1.7 (survey — shipped); Phase 3, Wave 3.2 (README.md + §2.4 rewrite) | required | Architecture doc trigger fired (>2 components) |
| DM-10 | Manual test procedures document | Docs | 2 (MV-XX trigger fired) | `docs/platform-adapter-retrofit-devspec.md` §6.4 (inline) | Phase 1, Wave 1.8 (MV-01..04 — closed 2026-04-26; MV-01 deferred per §6.4); Phase 3, Wave 3.5 (MV-05, MV-06) | required | Procedures defined inline in §6.4; executed in closing stories |

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
| MV-01 | **Deferred at Phase 1 close (2026-04-26).** The v1.7.0 binary is not recoverable in the current environment (no package cache, no release artifact, no local install), and reconstructing it via `git checkout v1.7.0 && ./scripts/ci/build.sh` is out of proportion to the incremental evidence it would produce. The 42 existing integration tests in `tests/pr_status.test.ts` (21/21) and `tests/pr_list.test.ts` (21/21) — all of which were preserved unchanged through the migrations per R-11 — are a tighter check of backward compatibility than a byte-diff against a random PR snapshot would be, because they encode the intended shape as assertions rather than comparing two samples that could both drift together. MV-01's belt-and-suspenders role is covered by those test suites. See #250 closing comment for the full rationale. | *deferred — see rationale* | R-11 |
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
- [x] Every Deliverables Manifest row has a "Produced In" wave assignment — Phase 1, Phase 2, and Phase 3 rows all carry specific wave assignments as of the 2026-04-26 amendment (§8 Phase 2 bound post-survey; §8 Phase 3 bound in the same pass per "plan end-to-end" rule).
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

PHASE 2 — Bug pre-work + 23 remaining migrations (bound 2026-04-26)
Wave 2.0  ─── Story 2.0: Fix pr_merge skip_train queue-strategy error (#280)
                  │
Wave 2.1  ─── Story 2.1: Land fetchIssue adapter (keystone sub-call)
                  │
Wave 2.2  ─┬─ Stories 2.2–2.6: spec_* family + epic_sub_issues (5 parallel)
            │
Wave 2.3  ─┬─ Stories 2.7–2.10: dod_load_manifest (+#283) + wave_* read family (4 parallel)
            │
Wave 2.4  ─┬─ Stories 2.11–2.14: ci_* full-migrations (4 parallel)
            │
Wave 2.5  ─┬─ Stories 2.15–2.17: label_* + work_item (+#281) (3 parallel)
            │
Wave 2.6  ─── Stories 2.18–2.24: sub-call-heavy migrations (serial; closes #282)

PHASE 3 — Cleanup, docs, release (bound 2026-04-26)
Wave 3.1  ─── Story 3.1: Delete lib/glab.ts
                  │
Wave 3.2  ─┬─ Story 3.2: Rewrite origin-ops-guide §2.4
            └─ Story 3.3: Write docs/adapters/README.md  (2 parallel)
                  │
Wave 3.3  ─── Story 3.4: Update root README.md
                  │
Wave 3.4  ─── Story 3.5: Tag v1.8.0 + release notes
                  │
Wave 3.5  ─── Story 3.6: Phase 3 closing — MV-05, MV-06, VRTM
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

#### Story 1.3: Migrate `pr_create`

**Wave:** 1.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_create` to the adapter pair, removing inline platform branching and direct subprocess calls from the handler.

**Implementation Steps:**

1. Add `prCreate(args: PrCreateArgs): Promise<AdapterResult<PrCreateResponse>>` signature to `PlatformAdapter` in `lib/adapters/types.ts` (if not already present from Story 1.2 scaffold)
2. Create `lib/adapters/pr-create-github.ts` — lift the GitHub-path logic from `handlers/pr_create.ts`; refactor to return `AdapterResult<PrCreateResponse>`
3. Create `lib/adapters/pr-create-gitlab.ts` — lift the GitLab-path logic from `handlers/pr_create.ts`; refactor to return `AdapterResult<PrCreateResponse>`
4. Wire `prCreate` into `lib/adapters/github.ts` and `lib/adapters/gitlab.ts` assemblers
5. Refactor `handlers/pr_create.ts` to ~50 lines: input validation via Zod + `getAdapter({repo}).prCreate(args)` dispatch + MCP envelope wrap
6. Move handler-level subprocess-boundary mocks from `tests/pr_create.test.ts` into colocated `lib/adapters/pr-create-{github,gitlab}.test.ts` files; preserve the integration-level `tests/pr_create.test.ts` for behavior regression
7. Remove `pr_create.ts` from `scripts/ci/migration-allowlist.txt`
8. Run `validate.sh` (gate-greps now enforce against `pr_create.ts`) and `bun test` — all 1378+ tests pass

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-create-github — gh CLI invocation matches expected argv` | Subprocess-boundary mock for GitHub path | `lib/adapters/pr-create-github.test.ts` |
| `pr-create-github — parses gh PR view response` | Output parsing correctness | `lib/adapters/pr-create-github.test.ts` |
| `pr-create-github — returns AdapterResult on error` | Error-path discriminator | `lib/adapters/pr-create-github.test.ts` |
| `pr-create-gitlab — glab CLI invocation matches expected argv` | Subprocess-boundary mock for GitLab path | `lib/adapters/pr-create-gitlab.test.ts` |
| `pr-create-gitlab — parses glab MR response` | Output parsing correctness | `lib/adapters/pr-create-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01 — handler→adapter dispatch verified by mocking the adapter
- IT-02 — adapter→subprocess argv shape verified via mock execSync
- IT-04 — `tests/pr_create.test.ts` integration tests preserved unchanged
- IT-05 — gate-greps in CI now active for `pr_create.ts`

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-create-github.ts` exists; returns `AdapterResult<PrCreateResponse>` [R-05]
- [ ] `lib/adapters/pr-create-gitlab.ts` exists; returns `AdapterResult<PrCreateResponse>` [R-05] (no asymmetric features identified for `pr_create`; if any surface during implementation, add `platform_unsupported` AC + regression test under [R-03] then)
- [ ] `handlers/pr_create.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Colocated tests: `lib/adapters/pr-create-github.test.ts` + `lib/adapters/pr-create-gitlab.test.ts` [R-15]
- [ ] Existing `tests/pr_create.test.ts` integration tests pass unchanged [R-11]
- [ ] `pr_create.ts` removed from `scripts/ci/migration-allowlist.txt` — gate-grep now enforces against this handler
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.4: Migrate `pr_diff`

**Wave:** 1.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_diff` to the adapter pair.

**Implementation Steps:**

1. Add `prDiff(args: PrDiffArgs): Promise<AdapterResult<PrDiffResponse>>` to `PlatformAdapter` in `lib/adapters/types.ts`
2. Create `lib/adapters/pr-diff-github.ts` — lift GitHub logic from `handlers/pr_diff.ts`; return `AdapterResult<PrDiffResponse>`
3. Create `lib/adapters/pr-diff-gitlab.ts` — lift GitLab logic; return `AdapterResult<PrDiffResponse>`
4. Wire `prDiff` into `lib/adapters/github.ts` and `lib/adapters/gitlab.ts` assemblers
5. Refactor `handlers/pr_diff.ts` to ~50 lines of validation + dispatch
6. Move subprocess-boundary mocks to colocated adapter test files
7. Remove `pr_diff.ts` from `scripts/ci/migration-allowlist.txt`
8. Run `validate.sh` + `bun test` — all 1378+ tests pass

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-diff-github — gh CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-diff-github.test.ts` |
| `pr-diff-github — parses unified diff output` | Output parsing | `lib/adapters/pr-diff-github.test.ts` |
| `pr-diff-github — handles 10000-line truncation` | Safety-valve regression | `lib/adapters/pr-diff-github.test.ts` |
| `pr-diff-gitlab — glab CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-diff-gitlab.test.ts` |
| `pr-diff-gitlab — parses unified diff output` | Output parsing | `lib/adapters/pr-diff-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-diff-github.ts` exists; returns `AdapterResult<PrDiffResponse>` [R-05]
- [ ] `lib/adapters/pr-diff-gitlab.ts` exists; returns `AdapterResult<PrDiffResponse>` [R-05]
- [ ] `handlers/pr_diff.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Colocated tests exist [R-15]
- [ ] Existing `tests/pr_diff.test.ts` integration tests pass unchanged [R-11]
- [ ] `pr_diff.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.5: Migrate `pr_files`

**Wave:** 1.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_files` to the adapter pair.

**Implementation Steps:**

1. Add `prFiles(args: PrFilesArgs): Promise<AdapterResult<PrFilesResponse>>` to `PlatformAdapter`
2. Create `lib/adapters/pr-files-github.ts` — lift GitHub logic from `handlers/pr_files.ts`
3. Create `lib/adapters/pr-files-gitlab.ts` — lift GitLab logic
4. Wire into adapter assemblers
5. Refactor `handlers/pr_files.ts` to ~50-line dispatch
6. Move tests to colocated adapter test files
7. Remove `pr_files.ts` from `scripts/ci/migration-allowlist.txt`
8. Run `validate.sh` + `bun test`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-files-github — gh CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-files-github.test.ts` |
| `pr-files-github — parses files-changed JSON response` | Output parsing | `lib/adapters/pr-files-github.test.ts` |
| `pr-files-gitlab — glab CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-files-gitlab.test.ts` |
| `pr-files-gitlab — parses MR diffs response` | Output parsing | `lib/adapters/pr-files-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-files-github.ts` exists; returns `AdapterResult<PrFilesResponse>` [R-05]
- [ ] `lib/adapters/pr-files-gitlab.ts` exists; returns `AdapterResult<PrFilesResponse>` [R-05]
- [ ] `handlers/pr_files.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Colocated tests exist [R-15]
- [ ] Existing `tests/pr_files.test.ts` integration tests pass unchanged [R-11]
- [ ] `pr_files.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.6: Migrate `pr_list`

**Wave:** 1.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_list` to the adapter pair.

**Implementation Steps:**

1. Add `prList(args: PrListArgs): Promise<AdapterResult<PrListResponse>>` to `PlatformAdapter`
2. Create `lib/adapters/pr-list-github.ts` — lift GitHub logic from `handlers/pr_list.ts`
3. Create `lib/adapters/pr-list-gitlab.ts` — lift GitLab logic
4. Wire into adapter assemblers
5. Refactor `handlers/pr_list.ts` to ~50-line dispatch
6. Move tests to colocated adapter test files
7. Remove `pr_list.ts` from `scripts/ci/migration-allowlist.txt`
8. Run `validate.sh` + `bun test`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-list-github — gh CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-list-github.test.ts` |
| `pr-list-github — parses PR list JSON response` | Output parsing | `lib/adapters/pr-list-github.test.ts` |
| `pr-list-github — supports state + author filters` | Filter argv translation | `lib/adapters/pr-list-github.test.ts` |
| `pr-list-gitlab — glab CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-list-gitlab.test.ts` |
| `pr-list-gitlab — parses MR list response` | Output parsing | `lib/adapters/pr-list-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-list-github.ts` exists; returns `AdapterResult<PrListResponse>` [R-05]
- [ ] `lib/adapters/pr-list-gitlab.ts` exists; returns `AdapterResult<PrListResponse>` [R-05]
- [ ] `handlers/pr_list.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Colocated tests exist [R-15]
- [ ] Existing `tests/pr_list.test.ts` integration tests pass unchanged [R-11]
- [ ] `pr_list.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.7: Migrate `pr_status`

**Wave:** 1.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_status` to the adapter pair. Note: `pr_status.ts` line 218 has the implicit `mr.pipeline?.status ?? mr.head_pipeline?.status` fallthrough that drops CI state — this story is the opportunity to make that explicit.

**Implementation Steps:**

1. Add `prStatus(args: PrStatusArgs): Promise<AdapterResult<PrStatusResponse>>` to `PlatformAdapter`
2. Create `lib/adapters/pr-status-github.ts` — lift GitHub logic from `handlers/pr_status.ts`; preserve the `aggregateGithubChecks` normalization
3. Create `lib/adapters/pr-status-gitlab.ts` — lift GitLab logic; make the pipeline-status fallthrough EXPLICIT (when both `pipeline?.status` and `head_pipeline?.status` are undefined, return a typed "no pipeline data" outcome rather than silently producing `summary: 'none'`)
4. Wire into adapter assemblers
5. Refactor `handlers/pr_status.ts` to ~50-line dispatch
6. Move tests to colocated adapter test files; add a regression test for the pipeline-status fallthrough fix
7. Remove `pr_status.ts` from `scripts/ci/migration-allowlist.txt`
8. Run `validate.sh` + `bun test`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-status-github — parses state + mergeStateStatus + checks` | Aggregate response | `lib/adapters/pr-status-github.test.ts` |
| `pr-status-github — aggregateGithubChecks counts pass/fail/pending` | Check normalization | `lib/adapters/pr-status-github.test.ts` |
| `pr-status-gitlab — parses state + detailed_merge_status` | Aggregate response | `lib/adapters/pr-status-gitlab.test.ts` |
| `pr-status-gitlab — pipeline-status fallthrough is explicit` | Regression for line 218 silent loss | `lib/adapters/pr-status-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-status-github.ts` exists; returns `AdapterResult<PrStatusResponse>` [R-05]
- [ ] `lib/adapters/pr-status-gitlab.ts` exists; returns `AdapterResult<PrStatusResponse>` [R-05]
- [ ] `handlers/pr_status.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Colocated tests exist [R-15]
- [ ] GitLab pipeline-status fallthrough is explicit (typed "no pipeline data" outcome, not silent `summary: 'none'`)
- [ ] Existing `tests/pr_status.test.ts` integration tests pass unchanged [R-11]
- [ ] `pr_status.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.8: Migrate `pr_comment`

**Wave:** 1.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_comment` to the adapter pair.

**Implementation Steps:**

1. Add `prComment(args: PrCommentArgs): Promise<AdapterResult<PrCommentResponse>>` to `PlatformAdapter`
2. Create `lib/adapters/pr-comment-github.ts` — lift GitHub logic from `handlers/pr_comment.ts`
3. Create `lib/adapters/pr-comment-gitlab.ts` — lift GitLab logic
4. Wire into adapter assemblers
5. Refactor `handlers/pr_comment.ts` to ~50-line dispatch
6. Move tests to colocated adapter test files
7. Remove `pr_comment.ts` from `scripts/ci/migration-allowlist.txt`
8. Run `validate.sh` + `bun test`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-comment-github — gh CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-comment-github.test.ts` |
| `pr-comment-github — multi-line comment via tempfile` | --body-file regression | `lib/adapters/pr-comment-github.test.ts` |
| `pr-comment-gitlab — glab CLI invocation matches expected argv` | Subprocess-boundary mock | `lib/adapters/pr-comment-gitlab.test.ts` |
| `pr-comment-gitlab — multi-line comment handling` | Body escaping regression | `lib/adapters/pr-comment-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-comment-github.ts` exists; returns `AdapterResult<PrCommentResponse>` [R-05]
- [ ] `lib/adapters/pr-comment-gitlab.ts` exists; returns `AdapterResult<PrCommentResponse>` [R-05]
- [ ] `handlers/pr_comment.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Colocated tests exist [R-15]
- [ ] Existing `tests/pr_comment.test.ts` integration tests pass unchanged [R-11]
- [ ] `pr_comment.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.9: Migrate `pr_wait_ci`

**Wave:** 1.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_wait_ci` to the adapter pair. Note: this handler has the gh<2.50 `--json statusCheckRollup` pattern from #220 + the all-skipped decide() fix from #221 — both must be preserved verbatim in the GitHub adapter. The async polling loop stays platform-agnostic.

**Implementation Steps:**

1. Add `prWaitCi(args: PrWaitCiArgs): Promise<AdapterResult<PrWaitCiResponse>>` to `PlatformAdapter`
2. Create `lib/adapters/pr-wait-ci-github.ts` — lift GitHub logic from `handlers/pr_wait_ci.ts`; preserve `gh pr view --json statusCheckRollup` pattern + `classifyRollupItem` + the all-skipped `decide()` fix
3. Create `lib/adapters/pr-wait-ci-gitlab.ts` — lift GitLab logic
4. Keep the polling loop as a `lib/` module — it's platform-agnostic
5. Wire into adapter assemblers
6. Refactor `handlers/pr_wait_ci.ts` to ~50-line dispatch
7. Move tests to colocated adapter test files; preserve the 19→38 test growth from #220/#221
8. Remove `pr_wait_ci.ts` from `scripts/ci/migration-allowlist.txt`
9. Run `validate.sh` + `bun test`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-wait-ci-github — uses gh pr view --json statusCheckRollup` | gh<2.50 compat regression | `lib/adapters/pr-wait-ci-github.test.ts` |
| `pr-wait-ci-github — classifyRollupItem cases (CheckRun + StatusContext)` | 14 case coverage | `lib/adapters/pr-wait-ci-github.test.ts` |
| `pr-wait-ci-github — all-skipped does not deadlock decide()` | #221 regression | `lib/adapters/pr-wait-ci-github.test.ts` |
| `pr-wait-ci-gitlab — glab API pipeline polling` | Subprocess-boundary mock | `lib/adapters/pr-wait-ci-gitlab.test.ts` |
| `pr-wait-ci-gitlab — pipeline status normalization` | Output parsing | `lib/adapters/pr-wait-ci-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-wait-ci-github.ts` exists; returns `AdapterResult<PrWaitCiResponse>` [R-05]
- [ ] `lib/adapters/pr-wait-ci-gitlab.ts` exists; returns `AdapterResult<PrWaitCiResponse>` [R-05]
- [ ] `handlers/pr_wait_ci.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Polling loop stays in `lib/` (platform-agnostic) — not duplicated per platform
- [ ] gh<2.50 compat preserved (no `gh pr checks --json` regression)
- [ ] All-skipped decide() fix preserved (#221 regression)
- [ ] Colocated tests exist [R-15]
- [ ] Existing `tests/pr_wait_ci.test.ts` integration tests pass unchanged [R-11]
- [ ] `pr_wait_ci.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.10: Migrate `pr_merge`

**Wave:** 1.5
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.2

Migrate `pr_merge` to the adapter pair. **Critical**: this handler is the most-recent contributor of leak inventory — `skip_train` is silently ignored on GitLab today. The GitLab adapter MUST return `platform_unsupported` for `skip_train: true`, demonstrating the typed-asymmetry pattern that justifies this entire retrofit.

**Implementation Steps:**

1. Add `prMerge(args: PrMergeArgs): Promise<AdapterResult<PrMergeResponse>>` to `PlatformAdapter`
2. Create `lib/adapters/pr-merge-github.ts` — lift GitHub logic from `handlers/pr_merge.ts`; preserve aggregate response shape from #225 (`enrolled`, `merged`, `merge_method`, `queue`, `pr_state`, `warnings`); preserve merge-queue detection via `lib/merge_queue_detect.ts` (which stays where it is per Section 5.3)
3. Create `lib/adapters/pr-merge-gitlab.ts` — lift GitLab logic; for `args.skip_train === true` return `{platform_unsupported: true, hint: 'merge trains are auto-managed by GitLab; skip_train is GitHub-merge-queue-only'}` instead of silently ignoring the flag
4. Wire `prMerge` into adapter assemblers
5. Refactor `handlers/pr_merge.ts` to ~50-line dispatch
6. Move tests to colocated adapter test files; preserve all 23 existing pr_merge tests + add `platform_unsupported` regression test for GitLab+skip_train
7. Remove `pr_merge.ts` from `scripts/ci/migration-allowlist.txt`
8. Run `validate.sh` + `bun test`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-merge-github — direct merge returns aggregate envelope` | #225 shape preservation | `lib/adapters/pr-merge-github.test.ts` |
| `pr-merge-github — queue path returns enrolled+OPEN` | #225 honesty preservation | `lib/adapters/pr-merge-github.test.ts` |
| `pr-merge-github — skip_train + enforced queue emits warning` | #224 fold preservation | `lib/adapters/pr-merge-github.test.ts` |
| `pr-merge-github — use_merge_queue + skip_train precedence warning` | #225 F3 preservation | `lib/adapters/pr-merge-github.test.ts` |
| `pr-merge-gitlab — direct merge returns aggregate envelope` | Cross-platform aggregate | `lib/adapters/pr-merge-gitlab.test.ts` |
| `pr-merge-gitlab — skip_train returns platform_unsupported` | Typed asymmetry exemplar | `lib/adapters/pr-merge-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05
- MV-02 (post-Phase-1 manual verification of `platform_unsupported` on GitLab)

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-merge-github.ts` exists; returns `AdapterResult<PrMergeResponse>` with #225 aggregate shape preserved [R-05]
- [ ] `lib/adapters/pr-merge-gitlab.ts` exists; returns `AdapterResult<PrMergeResponse>` for normal flow [R-05]
- [ ] **`lib/adapters/pr-merge-gitlab.ts:prMerge` returns `{platform_unsupported: true, hint: 'merge trains are auto-managed by GitLab; skip_train is GitHub-merge-queue-only'}` when `args.skip_train === true`** [R-03]
- [ ] `handlers/pr_merge.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] All 23 existing pr_merge tests pass unchanged [R-11]
- [ ] New regression test: GitLab+skip_train returns `platform_unsupported` [R-03]
- [ ] Colocated tests exist [R-15]
- [ ] `pr_merge.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

---

#### Story 1.11: Migrate `pr_merge_wait`

**Wave:** 1.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 1.10

Migrate `pr_merge_wait` to the adapter pair. The polling logic (`pollUntilMerged`) is platform-agnostic and stays in a `lib/` module. The state-fetch helper at `lib/pr_state.ts` directly calls `execSync('gh pr view ...')` and `gitlabApiMr()` today — this story migrates it to a proper adapter pair so the gate-grep's spirit holds (closes architect F2).

**Implementation Steps:**

1. Add `prMergeWait(args: PrMergeWaitArgs): Promise<AdapterResult<PrMergeWaitResponse>>` to `PlatformAdapter`
2. Add `fetchPrState(args: FetchPrStateArgs): Promise<AdapterResult<PrStateInfo>>` to `PlatformAdapter` (hybrid sub-call; needed by both `pr_merge_wait` and any future state-polling consumer)
3. Create `lib/adapters/pr-merge-wait-github.ts` and `lib/adapters/pr-merge-wait-gitlab.ts` — lift handler logic; both call the new `fetchPrState` adapter method via `getAdapter()`
4. Create `lib/adapters/fetch-pr-state-github.ts` and `lib/adapters/fetch-pr-state-gitlab.ts` — lift the subprocess calls from `lib/pr_state.ts` into adapter form
5. Refactor `lib/pr_state.ts` to delegate to the new adapter (or delete entirely + update remaining importers). After this story, `lib/pr_state.ts` contains zero direct subprocess calls
6. `handlers/pr_merge_wait.ts` no longer imports `performMerge` from `pr_merge.ts` — instead calls `getAdapter().prMerge(args)` directly; polling loop calls `getAdapter().fetchPrState(args)` directly
7. Wire `prMergeWait` and `fetchPrState` into adapter assemblers
8. Refactor `handlers/pr_merge_wait.ts` to ~50-line dispatch (validation + `getAdapter().prMergeWait(args)`)
9. Move tests to colocated adapter test files
10. Remove `pr_merge_wait.ts` from `scripts/ci/migration-allowlist.txt`
11. Run `validate.sh` + `bun test`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-merge-wait-github — direct merge short-circuits polling` | #225 short-circuit preservation | `lib/adapters/pr-merge-wait-github.test.ts` |
| `pr-merge-wait-github — queue merge polls until MERGED` | #225 polling behavior | `lib/adapters/pr-merge-wait-github.test.ts` |
| `pr-merge-wait-github — already-merged detect-and-skip` | #225 short-circuit preservation | `lib/adapters/pr-merge-wait-github.test.ts` |
| `pr-merge-wait-github — fetch_error mid-poll preserves "after enrollment"` | #225 F2 preservation | `lib/adapters/pr-merge-wait-github.test.ts` |
| `pr-merge-wait-github — timeout returns clean error` | Timeout regression | `lib/adapters/pr-merge-wait-github.test.ts` |
| `pr-merge-wait-gitlab — same as github but via glab` | Cross-platform parity | `lib/adapters/pr-merge-wait-gitlab.test.ts` |
| `fetch-pr-state-github — gh pr view --json state,url,mergeCommit` | Subprocess-boundary mock | `lib/adapters/fetch-pr-state-github.test.ts` |
| `fetch-pr-state-gitlab — glab api MR state` | Subprocess-boundary mock | `lib/adapters/fetch-pr-state-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-02, IT-04, IT-05

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-merge-wait-github.ts` exists; returns `AdapterResult<PrMergeWaitResponse>` [R-05]
- [ ] `lib/adapters/pr-merge-wait-gitlab.ts` exists; returns `AdapterResult<PrMergeWaitResponse>` [R-05]
- [ ] `lib/adapters/fetch-pr-state-github.ts` and `lib/adapters/fetch-pr-state-gitlab.ts` exist [R-05]
- [ ] `handlers/pr_merge_wait.ts` is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] `handlers/pr_merge_wait.ts` no longer imports `performMerge` from `pr_merge.ts`
- [ ] **Polling logic (`pollUntilMerged`) stays as a `lib/` module — it's platform-agnostic; not duplicated per platform**
- [ ] **Migrate `lib/pr_state.ts` to adapter pair**: `lib/pr_state.ts` itself contains zero direct subprocess calls post-story (closes the gap that `lib/pr_state.ts` is in `lib/`, not `handlers/`, so the gate-grep won't catch its subprocess calls) [R-10 spirit, architect F2]
- [ ] All 16 existing pr_merge_wait tests pass unchanged [R-11]
- [ ] Colocated tests exist [R-15]
- [ ] `pr_merge_wait.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] Gate-greps pass on the touched handler [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (1378+ tests)

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

### Phase 2: Migrate remaining 23 handlers + close Phase-1 bug follow-ups (Epic)

**Goal:** Complete the platform-aware handler migration. Land `fetchIssue` as the keystone sub-call, migrate the four non-`pr_*` handler families (CI, label/work-item, spec, wave), and close the four in-repo bug follow-ups from Phase 1 either as pre-work (bug blocking every migration) or inline with the handler they concern.

#### Phase 2 Definition of Done

- [ ] Every handler in `scripts/ci/migration-allowlist.txt` (23 entries as of Phase 1 close) migrated; allowlist has zero `handlers/` entries remaining
- [ ] `PlatformAdapter` interface extended by 16 new methods (7 full-migration + 9 hybrid sub-calls); `PLATFORM_ADAPTER_METHODS` runtime registry and `MIGRATED_METHODS` contract-test set both include every new method (Phase 1 shipped 10 → Phase 2 close has 26 total)
- [ ] Every migrated handler is ≤80 lines; no platform branching; no direct subprocess calls
- [ ] Gate-greps pass on the full handlers tree (non-allowlisted handlers is now all handlers)
- [ ] Colocated adapter tests exist for every new adapter method-pair and hybrid sub-call [R-15]
- [ ] All pre-Phase-2 integration tests (1659 baseline) pass unchanged [R-11]
- [ ] Bug #280 (`pr_merge skip_train` queue-strategy error) fixed and closed via Wave 2.0
- [ ] Bug #281 (`work_item` type-vs-platform routing) fixed and closed via Story 2.17
- [ ] Bug #282 (`wave_reconcile_mrs` 50-item scan cap) addressed and closed via Story 2.21
- [ ] Bug #283 (`dod_load_manifest` cross-repo GitLab gap) closed via Story 2.7
- [ ] `lib/glab.ts` retains only re-export shims (full deletion in Phase 3, Story 3.1)
- [ ] Full suite ≥ 1659 + per-story added tests; zero regressions

---

### Wave Map (Phase 2)

```
PHASE 2 — Bug pre-work + 23 remaining migrations
─────────────────────────────────────────────────
Wave 2.0  ─── Story 2.0: Fix pr_merge skip_train on queue-enforced repos (#280)
                  │      (standalone, pre-pa-6; unblocks every subsequent wave-merge)
                  ▼
Wave 2.1  ─── Story 2.1: Land fetchIssue adapter + types refinement
                  │      (keystone sub-call; 10 downstream consumers)
                  ▼
Wave 2.2  ─┬─ Story 2.2: Migrate spec_get
            ├─ Story 2.3: Migrate spec_validate_structure      (5 parallel —
            ├─ Story 2.4: Migrate spec_acceptance_criteria      fetchIssue consumers,
            ├─ Story 2.5: Migrate spec_dependencies             disjoint files)
            └─ Story 2.6: Migrate epic_sub_issues
                  │
Wave 2.3  ─┬─ Story 2.7: Migrate dod_load_manifest (+close #283)
            ├─ Story 2.8: Migrate wave_compute                  (4 parallel —
            ├─ Story 2.9: Migrate wave_dependency_graph          fetchIssue consumers
            └─ Story 2.10: Migrate wave_topology                 round 2)
                  │
Wave 2.4  ─┬─ Story 2.11: Migrate ci_failed_jobs                (4 parallel — CI
            ├─ Story 2.12: Migrate ci_run_logs                   full-migrations,
            ├─ Story 2.13: Migrate ci_run_status                 disjoint files)
            └─ Story 2.14: Migrate ci_runs_for_branch
                  │
Wave 2.5  ─┬─ Story 2.15: Migrate label_create                  (3 parallel —
            ├─ Story 2.16: Migrate label_list                    remaining full-
            └─ Story 2.17: Migrate work_item (+close #281)       migrations)
                  │
Wave 2.6  ─┬─ Story 2.18: Migrate ibm (+fetchPrForBranch)       (serial — sub-call
            ├─ Story 2.19: Migrate ci_wait_run                    churn in types.ts;
            │             (+ciListRuns, +resolveBranchSha)        each story adds
            ├─ Story 2.20: Migrate wave_previous_merged           ≥1 new method)
            │             (+fetchIssueClosure)
            ├─ Story 2.21: Migrate wave_reconcile_mrs
            │             (+findMergedPrForBranchPrefix; close #282)
            ├─ Story 2.22: Migrate wave_init
            │             (+resolveBranchSha reused, +createBranch)
            ├─ Story 2.23: Migrate wave_finalize
            │             (+findExistingPr; reuses prCreate)
            └─ Story 2.24: Migrate wave_ci_trust_level
                          (+fetchCiTrustSignal)
```

| Wave | Stories | Master Issue | Parallel? |
|------|---------|-------------|-----------|
| 2.0 | 2.0 | Story 2.0 | Single story (bug pre-work) |
| 2.1 | 2.1 | Story 2.1 | Single story (keystone sub-call) |
| 2.2 | 2.2, 2.3, 2.4, 2.5, 2.6 | Wave 2.2 Master | Yes — 5 parallel |
| 2.3 | 2.7, 2.8, 2.9, 2.10 | Wave 2.3 Master | Yes — 4 parallel |
| 2.4 | 2.11, 2.12, 2.13, 2.14 | Wave 2.4 Master | Yes — 4 parallel |
| 2.5 | 2.15, 2.16, 2.17 | Wave 2.5 Master | Yes — 3 parallel |
| 2.6 | 2.18, 2.19, 2.20, 2.21, 2.22, 2.23, 2.24 | Wave 2.6 Master | No — serial (types.ts churn) |

**Story count:** 25 (1 bug pre-work + 1 keystone + 23 handler migrations). Three migration stories embed a bug close (#281, #282, #283). `Wave 2.1` is structurally identical to Wave 1.2 — single foundational story before the consumer cluster.

**File-overlap note.** Every Wave 2.2–2.5 flight touches disjoint handler files; the only shared file across any two flights in the same wave is `scripts/ci/migration-allowlist.txt` (single-line removal, commutes cleanly per Phase 1 precedent). Wave 2.6 is serial because each story mutates `lib/adapters/types.ts` (interface additions) and `lib/adapters/types.test.ts::MIGRATED_METHODS` (registry additions) — linearizing avoids interface-shape merge conflicts.

---

#### Story 2.0: Fix `pr_merge skip_train` queue-strategy error on queue-enforced repos (bug #280)

**Wave:** 2.0
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** none (Phase 1 closed)

Close bug #280 before any Phase 2 migration begins. The bug: on a repo with GitHub merge-queue enforcement, `pr_merge({skip_train: true})` errors with a queue-strategy message instead of silently falling back to the queue path. Every Phase 2 migration lands via `pr_merge` and would hit this path; fixing it first keeps every subsequent wave unblocked.

**Implementation Steps:**

1. Read `lib/adapters/pr-merge-github.ts` — the handler branch that runs `gh pr merge --merge --admin` when `skip_train: true` and the branch that runs `gh pr merge --auto --squash` when `skip_train: false`
2. Detect the queue-strategy error signature returned by `gh` on queue-enforced repos (the error body mentions "merge strategy not allowed")
3. On detection, drop `--admin` and re-invoke with `--auto` (queue-enqueue path) — the eager success semantics from `lesson_merge_queue_pattern.md` still apply
4. Add typed response field `queue_fallback: boolean` when the fallback triggers so callers can log the decision
5. Add unit test: given a `gh pr merge --admin` invocation that returns the queue-strategy error, the adapter retries with `--auto` and returns `{ok: true, queue_fallback: true}`
6. Close issue #280 in PR body via `Closes #280`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `pr-merge-github — queue-strategy error triggers --auto fallback` | Regression for #280 | `lib/adapters/pr-merge-github.test.ts` |
| `pr-merge-github — queue_fallback: true in response when fallback fires` | Response shape | `lib/adapters/pr-merge-github.test.ts` |
| `pr-merge-github — no fallback when merge-admin succeeds` | Happy path unchanged | `lib/adapters/pr-merge-github.test.ts` |

*Integration/E2E Coverage:*
- IT-02 — adapter→subprocess argv shape for both initial and retry invocation
- IT-04 — existing `tests/pr_merge.test.ts` integration tests preserved unchanged

**Acceptance Criteria:**

- [ ] `lib/adapters/pr-merge-github.ts` detects the queue-strategy error and re-invokes with `--auto` [bug #280]
- [ ] Response shape includes `queue_fallback: boolean` field; defaults `false`
- [ ] Three new unit tests cover fallback, response shape, and no-fallback paths
- [ ] Existing `tests/pr_merge.test.ts` integration tests pass unchanged [R-11]
- [ ] Gate-greps pass [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes (≥1659 + 3 new unit tests)
- [ ] Issue #280 closed via PR

---

#### Story 2.1: Land `fetchIssue` adapter + types refinement (keystone sub-call)

**Wave:** 2.1
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.0

Add the `fetchIssue` sub-call to the adapter — the single widest-reach platform operation in the retrofit, consumed by 10 downstream handlers (`ibm`, `spec_get`, `spec_validate_structure`, `spec_acceptance_criteria`, `spec_dependencies`, `epic_sub_issues`, `wave_compute`, `wave_dependency_graph`, `wave_topology`, `dod_load_manifest`). Landing it first makes Waves 2.2 and 2.3 near-mechanical handler lifts.

**Implementation Steps:**

1. Add `fetchIssue(args: { number: number, repo?: string }): Promise<AdapterResult<{ number: number, title: string, state: 'OPEN' | 'CLOSED', url: string, body: string, labels: string[] }>>` to `PlatformAdapter` in `lib/adapters/types.ts`
2. Create `lib/adapters/fetch-issue-github.ts` — uses `gh issue view --json number,title,state,url,body,labels`; normalize state enum
3. Create `lib/adapters/fetch-issue-gitlab.ts` — uses `glab api projects/:id/issues/:iid` via the existing `gitlabApiIssue()` helper in `lib/glab.ts` (consumer migration in Phase 3 Story 3.1 deletes `lib/glab.ts`; pre-deletion this is the supported path)
4. Wire into `lib/adapters/github.ts` and `lib/adapters/gitlab.ts` assemblers
5. Add `'fetchIssue'` to `MIGRATED_METHODS` in `lib/adapters/types.test.ts`
6. Add colocated tests: argv-shape for both platforms, response-parsing for both, error-path `AdapterResult.error` for both

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `fetch-issue-github — argv shape: gh issue view --json ... <number>` | Subprocess-boundary mock for GitHub | `lib/adapters/fetch-issue-github.test.ts` |
| `fetch-issue-github — normalizes state + labels array` | Output parsing correctness | `lib/adapters/fetch-issue-github.test.ts` |
| `fetch-issue-github — returns AdapterResult.error on gh failure` | Error-path discriminator | `lib/adapters/fetch-issue-github.test.ts` |
| `fetch-issue-gitlab — argv shape via gitlabApiIssue helper` | Subprocess-boundary mock for GitLab | `lib/adapters/fetch-issue-gitlab.test.ts` |
| `fetch-issue-gitlab — parses glab api response into normalized shape` | Output parsing correctness | `lib/adapters/fetch-issue-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-03 — contract test: `MIGRATED_METHODS` now 11/26 after this story (10 shipped Phase 1 + `fetchIssue`)

**Acceptance Criteria:**

- [ ] `PlatformAdapter.fetchIssue` signature added to `lib/adapters/types.ts` [R-01]
- [ ] `lib/adapters/fetch-issue-{github,gitlab}.ts` both exist and return `AdapterResult<FetchIssueResponse>` [R-05]
- [ ] Assemblers wire `fetchIssue` for both platforms
- [ ] `'fetchIssue'` added to `MIGRATED_METHODS` in contract test [R-04]
- [ ] Colocated tests exist for both adapters [R-15]
- [ ] Gate-greps still pass [R-09, R-10]
- [ ] Full suite passes (≥ 1659 + 5 new unit tests)
- [ ] No handler migrated yet — Wave 2.2 lands the first consumer

---

#### Story 2.2: Migrate `spec_get`

**Wave:** 2.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1 (requires `fetchIssue` adapter)

Migrate `spec_get` to consume the `fetchIssue` sub-call. The handler's markdown section-parsing logic (`parseSections` in `lib/spec_parser`) stays in `lib/`; only the platform-specific `fetchBody` call is replaced.

**Implementation Steps:**

1. Refactor `handlers/spec_get.ts` to call `getAdapter({repo}).fetchIssue({number, repo})` instead of the inline `fetchBody` helper
2. Delete the handler-local `fetchBody(ref)` helper; all 4 spec handlers share this helper today — deletion happens here and Stories 2.3-2.5 each remove their own duplicate copy
3. Validate `handlers/spec_get.ts` is ≤80 lines after refactor
4. Remove `spec_get.ts` from `scripts/ci/migration-allowlist.txt`
5. Preserve `tests/spec_get.test.ts` integration tests unchanged (mock the adapter if needed; adapter mock pattern matches `fetch-issue-github.test.ts`)

**Test Procedures:**

*Unit Tests:* none new — the adapter is already covered by Story 2.1's tests; `spec_get` is now a thin dispatcher.

*Integration/E2E Coverage:*
- IT-01 — `tests/spec_get.test.ts` verifies handler→adapter dispatch via adapter mock
- IT-04 — existing integration tests preserved unchanged [R-11]
- IT-05 — gate-greps now active for `spec_get.ts`

**Acceptance Criteria:**

- [ ] `handlers/spec_get.ts` is ≤80 lines; no platform branching; no direct subprocess calls [R-05, R-09, R-10]
- [ ] `fetchBody` helper removed from `handlers/spec_get.ts`
- [ ] `spec_get.ts` removed from `scripts/ci/migration-allowlist.txt`
- [ ] `tests/spec_get.test.ts` integration tests pass unchanged [R-11]
- [ ] Gate-greps pass [R-09, R-10]
- [ ] Contract test still passes [R-04]
- [ ] Full suite passes

---

#### Story 2.3: Migrate `spec_validate_structure`

**Wave:** 2.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `spec_validate_structure` to consume `fetchIssue`. H2-section validation logic stays in the handler; only `fetchBody` is replaced.

**Implementation Steps:**

1. Refactor `handlers/spec_validate_structure.ts` to call `getAdapter({repo}).fetchIssue({number, repo})`
2. Delete handler-local `fetchBody` helper
3. Verify ≤80 lines
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Preserve `tests/spec_validate_structure.test.ts` integration tests unchanged

**Test Procedures:**

*Unit Tests:* none new.

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `handlers/spec_validate_structure.ts` is ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Handler-local `fetchBody` removed
- [ ] Removed from migration allowlist
- [ ] Existing integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.4: Migrate `spec_acceptance_criteria`

**Wave:** 2.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `spec_acceptance_criteria` to consume `fetchIssue`. Checklist-regex parsing stays in the handler.

**Implementation Steps:**

1. Refactor `handlers/spec_acceptance_criteria.ts` to call `getAdapter({repo}).fetchIssue(...)`
2. Delete handler-local `fetchBody`
3. Verify ≤80 lines
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Preserve integration tests unchanged

**Test Procedures:**

*Unit Tests:* none new.

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] Handler ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] `fetchBody` removed
- [ ] Removed from allowlist
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.5: Migrate `spec_dependencies`

**Wave:** 2.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `spec_dependencies` to consume `fetchIssue`. `## Dependencies` section parsing and bold-label fallback stay in the handler.

**Implementation Steps:**

1. Refactor `handlers/spec_dependencies.ts` to call `getAdapter({repo}).fetchIssue(...)`
2. Delete handler-local `fetchBody`
3. Verify ≤80 lines
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Preserve integration tests unchanged

**Test Procedures:**

*Unit Tests:* none new.

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] Handler ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] `fetchBody` removed
- [ ] Removed from allowlist
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.6: Migrate `epic_sub_issues`

**Wave:** 2.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `epic_sub_issues` to consume `fetchIssue`. The ~200 LoC of markdown table / checklist / reference-normalization parsing (`parseTableRows`, `parseChecklistOrBullets`, `normalizeRef`) stays in the handler — only `fetchBody` is replaced.

**Implementation Steps:**

1. Refactor `handlers/epic_sub_issues.ts` to call `getAdapter({repo}).fetchIssue(...)`
2. Delete handler-local `fetchBody`
3. Verify handler ≤80 lines is NOT expected for this story (the markdown parsers alone exceed 80 lines) — confirm ≤80 lines post-refactor by counting only dispatch + envelope logic and promoting parsers to `lib/epic-sub-issues-parser.ts` if needed
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Preserve integration tests unchanged

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `epic-sub-issues-parser — table row extraction` | Preserve parser correctness post-extraction | `lib/epic-sub-issues-parser.test.ts` |
| `epic-sub-issues-parser — checklist/bullet extraction` | Preserve parser correctness | `lib/epic-sub-issues-parser.test.ts` |
| `epic-sub-issues-parser — ref normalization` | Preserve parser correctness | `lib/epic-sub-issues-parser.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `handlers/epic_sub_issues.ts` is ≤80 lines after promoting parsers; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Parsers extracted to `lib/epic-sub-issues-parser.ts` if needed; colocated tests live alongside
- [ ] `fetchBody` removed
- [ ] Removed from allowlist
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.7: Migrate `dod_load_manifest` + close #283 (cross-repo GitLab gap)

**Wave:** 2.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `dod_load_manifest` to consume `fetchIssue`. **Close #283 in the same PR:** today the cross-repo `ISSUE_REF` branch fires only when `platform === 'github'`, leaving GitLab silently broken for `org/project#N` manifest refs; migrating to `fetchIssue` (which accepts `repo` per its signature) closes the gap.

**Implementation Steps:**

1. Refactor `handlers/dod_load_manifest.ts` to call `getAdapter({repo}).fetchIssue(...)` — pass the parsed `repo` through so cross-repo refs on GitLab resolve correctly
2. Delete the GitHub-only `m1` branch; the adapter dispatch handles both platforms uniformly
3. Verify ≤80 lines (markdown manifest extraction promotes to `lib/dod-manifest-parser.ts` if needed)
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Close #283 in PR body via `Closes #283`
6. Add integration test: `org/project#N` manifest ref on GitLab resolves correctly (regression for #283)

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `dod-manifest-parser — reads cross-repo refs on GitLab` | Regression for #283 | `lib/dod-manifest-parser.test.ts` |
| `dod-manifest-parser — reads cross-repo refs on GitHub (unchanged)` | Behavior preservation | `lib/dod-manifest-parser.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `handlers/dod_load_manifest.ts` is ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Cross-repo refs resolve on both GitHub and GitLab via `fetchIssue`
- [ ] Regression test for #283 passes
- [ ] Removed from allowlist
- [ ] Issue #283 closed via PR
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.8: Migrate `wave_compute`

**Wave:** 2.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `wave_compute` to consume `fetchIssue`. All wave-computation, sub-issue parsing, dependency-parsing, and story-self-fallback logic stays in the handler (~300 LoC of platform-agnostic orchestration).

**Implementation Steps:**

1. Refactor `handlers/wave_compute.ts` to call `getAdapter({repo}).fetchIssue(...)` where the handler currently imports its local `fetchIssue`
2. Delete handler-local `fetchIssue` helper
3. Verify handler ≤80 lines is not expected (wave-computation exceeds); promote wave-computation to `lib/wave-compute.ts` if needed
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Preserve integration tests unchanged

**Test Procedures:**

*Unit Tests:* none new if wave-computation stays in handler; if promoted to `lib/`, colocate unit tests for the moved functions.

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `handlers/wave_compute.ts` is ≤80 lines after promoting wave-computation to `lib/` if needed; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Handler-local `fetchIssue` removed
- [ ] Removed from allowlist
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.9: Migrate `wave_dependency_graph`

**Wave:** 2.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `wave_dependency_graph` to consume `fetchIssue`. Dependency-parsing logic stays (near-duplicate of `wave_compute`'s; a future refactor could share — not part of this story).

**Implementation Steps:**

1. Refactor `handlers/wave_dependency_graph.ts` to call `getAdapter({repo}).fetchIssue(...)`
2. Delete handler-local `fetchIssue`
3. Verify ≤80 lines (promote graph logic to `lib/wave-dependency-graph.ts` if needed)
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Preserve integration tests unchanged

**Test Procedures:**

*Unit Tests:* none new.

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] Handler ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] `fetchIssue` removed
- [ ] Removed from allowlist
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.10: Migrate `wave_topology`

**Wave:** 2.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.1

Migrate `wave_topology` to consume `fetchIssue`. Same shape as `wave_dependency_graph`.

**Implementation Steps:**

1. Refactor `handlers/wave_topology.ts` to call `getAdapter({repo}).fetchIssue(...)`
2. Delete handler-local `fetchIssue`
3. Verify ≤80 lines
4. Remove from `scripts/ci/migration-allowlist.txt`
5. Preserve integration tests unchanged

**Test Procedures:**

*Unit Tests:* none new.

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] Handler ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] `fetchIssue` removed
- [ ] Removed from allowlist
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.11: Migrate `ci_failed_jobs` (full-migration)

**Wave:** 2.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1 (foundational); no inter-Wave 2.4 deps

Full-migration: lift entire handler into adapter pair. The handler is a thin platform wrapper around `gh run view --json jobs` / `glab api projects/:id/pipelines/<id>/jobs` with identical `FailedJob[]` normalization.

**Implementation Steps:**

1. Add `ciFailedJobs(args: { run_id: string, repo?: string }): Promise<AdapterResult<{ failed_jobs: FailedJob[] }>>` to `PlatformAdapter` in `lib/adapters/types.ts`
2. Create `lib/adapters/ci-failed-jobs-github.ts` — lift `fetchGithubFailedJobs` logic
3. Create `lib/adapters/ci-failed-jobs-gitlab.ts` — lift `fetchGitlabFailedJobs` logic
4. Wire into `lib/adapters/{github,gitlab}.ts` assemblers
5. Add `'ciFailedJobs'` to `MIGRATED_METHODS`
6. Refactor `handlers/ci_failed_jobs.ts` to ~40 lines: validate + dispatch + envelope
7. Move subprocess-boundary mocks from `tests/ci_failed_jobs.test.ts` into colocated adapter test files; preserve integration tests
8. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `ci-failed-jobs-github — argv: gh run view <id> --json jobs` | Subprocess-boundary mock | `lib/adapters/ci-failed-jobs-github.test.ts` |
| `ci-failed-jobs-github — normalizes failed jobs` | Output parsing | `lib/adapters/ci-failed-jobs-github.test.ts` |
| `ci-failed-jobs-github — returns AdapterResult.error on gh failure` | Error-path | `lib/adapters/ci-failed-jobs-github.test.ts` |
| `ci-failed-jobs-gitlab — argv: glab api projects/:id/pipelines/<id>/jobs` | Subprocess-boundary mock | `lib/adapters/ci-failed-jobs-gitlab.test.ts` |
| `ci-failed-jobs-gitlab — normalizes failed jobs` | Output parsing | `lib/adapters/ci-failed-jobs-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.ciFailedJobs` signature added [R-01]
- [ ] `lib/adapters/ci-failed-jobs-{github,gitlab}.ts` both exist; return `AdapterResult<FailedJobsResponse>` [R-05]
- [ ] `handlers/ci_failed_jobs.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'ciFailedJobs'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.12: Migrate `ci_run_logs` (full-migration)

**Wave:** 2.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1

Full-migration: `fetchGithub()` (gh run view --log / --log-failed) vs `fetchGitlab()` (glab api to find failed job + glab ci trace). `truncateLogs()` helper is platform-agnostic; extract to `lib/shared/truncate-logs.ts`.

**Implementation Steps:**

1. Add `ciRunLogs(args: { run_id: string, failed_only: boolean, repo?: string }): Promise<AdapterResult<{ logs: string, job_id?: string, url: string }>>` to `PlatformAdapter`
2. Extract `truncateLogs` to `lib/shared/truncate-logs.ts` with colocated test
3. Create `lib/adapters/ci-run-logs-{github,gitlab}.ts`
4. Wire into assemblers
5. Add to `MIGRATED_METHODS`
6. Refactor `handlers/ci_run_logs.ts` to ~50 lines; the truncation step composes against the adapter response
7. Move subprocess-boundary mocks into adapter tests; preserve integration tests
8. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `ci-run-logs-github — argv: gh run view <id> --log / --log-failed` | Subprocess-boundary mock | `lib/adapters/ci-run-logs-github.test.ts` |
| `ci-run-logs-github — returns AdapterResult with logs + url` | Output parsing | `lib/adapters/ci-run-logs-github.test.ts` |
| `ci-run-logs-gitlab — argv: glab api + glab ci trace` | Subprocess-boundary mock | `lib/adapters/ci-run-logs-gitlab.test.ts` |
| `ci-run-logs-gitlab — resolves failed job then fetches trace` | Two-step flow | `lib/adapters/ci-run-logs-gitlab.test.ts` |
| `shared/truncate-logs — truncates to configured limit, preserves tail` | Behavior preservation | `lib/shared/truncate-logs.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.ciRunLogs` signature added [R-01]
- [ ] `lib/adapters/ci-run-logs-{github,gitlab}.ts` exist [R-05]
- [ ] `lib/shared/truncate-logs.ts` extracted; imported by handler [R-17]
- [ ] `handlers/ci_run_logs.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'ciRunLogs'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.13: Migrate `ci_run_status` (full-migration)

**Wave:** 2.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1

Full-migration: `ghQueryRuns` / `glQueryRuns` + `normalizeGh` / `normalizeGl` status-enum mapping. Enum mapping belongs with each platform adapter (platform-shape-to-normalized-shape glue).

**Implementation Steps:**

1. Add `ciRunStatus(args: { ref: string, workflow_name?: string, repo?: string }): Promise<AdapterResult<NormalizedRun | null>>` to `PlatformAdapter`
2. Create `lib/adapters/ci-run-status-{github,gitlab}.ts` — lift platform query + normalization
3. Move `gitlabApiCiList` call from `lib/glab.ts` into `ci-run-status-gitlab.ts` (consistent with R-16; `lib/glab.ts` deletion in Phase 3 Story 3.1)
4. Wire into assemblers; add to `MIGRATED_METHODS`
5. Refactor `handlers/ci_run_status.ts` to ~40 lines
6. Move subprocess-boundary mocks; preserve integration tests
7. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `ci-run-status-github — argv + normalization for success/failure/in-progress` | Full enum coverage | `lib/adapters/ci-run-status-github.test.ts` |
| `ci-run-status-github — null return when no matching run` | Empty-result path | `lib/adapters/ci-run-status-github.test.ts` |
| `ci-run-status-gitlab — argv + normalization` | Full enum coverage | `lib/adapters/ci-run-status-gitlab.test.ts` |
| `ci-run-status-gitlab — null return` | Empty-result path | `lib/adapters/ci-run-status-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.ciRunStatus` signature added [R-01]
- [ ] `lib/adapters/ci-run-status-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/ci_run_status.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'ciRunStatus'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.14: Migrate `ci_runs_for_branch` (full-migration)

**Wave:** 2.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1

Full-migration: `githubStatusFlag` / `gitlabStatusFlag` translation + platform list queries + platform normalization.

**Implementation Steps:**

1. Add `ciRunsForBranch(args: { branch: string, limit?: number, status?: 'in_progress'|'completed'|'queued'|'all', repo?: string }): Promise<AdapterResult<{ runs: RunRecord[] }>>` to `PlatformAdapter`
2. Create `lib/adapters/ci-runs-for-branch-{github,gitlab}.ts` — lift the status-flag translation and queries
3. Wire into assemblers; add to `MIGRATED_METHODS`
4. Refactor `handlers/ci_runs_for_branch.ts` to ~40 lines
5. Move subprocess-boundary mocks; preserve integration tests
6. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `ci-runs-for-branch-github — argv for each status flag` | Status flag translation | `lib/adapters/ci-runs-for-branch-github.test.ts` |
| `ci-runs-for-branch-github — normalizes response` | Output parsing | `lib/adapters/ci-runs-for-branch-github.test.ts` |
| `ci-runs-for-branch-gitlab — argv for each status flag` | Status flag translation | `lib/adapters/ci-runs-for-branch-gitlab.test.ts` |
| `ci-runs-for-branch-gitlab — normalizes response` | Output parsing | `lib/adapters/ci-runs-for-branch-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.ciRunsForBranch` signature added [R-01]
- [ ] `lib/adapters/ci-runs-for-branch-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/ci_runs_for_branch.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'ciRunsForBranch'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.15: Migrate `label_create` (full-migration)

**Wave:** 2.5
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1

Full-migration: create-with-idempotent-duplicate-fallback. Platform-specific color normalization (`#RRGGBB` vs bare hex) lives inside each adapter per `lesson_origin_ops_pitfalls.md`.

**Implementation Steps:**

1. Add `labelCreate(args: { name: string, color?: string, description?: string, repo?: string }): Promise<AdapterResult<NormalizedLabel>>` to `PlatformAdapter`
2. Create `lib/adapters/label-create-{github,gitlab}.ts` — lift `createGithubLabel` + `lookupGithubLabel` fallback / `createGitlabLabel` + `lookupGitlabLabel` fallback
3. Adapter internalizes the duplicate-lookup retry
4. Wire into assemblers; add to `MIGRATED_METHODS`
5. Refactor `handlers/label_create.ts` to ~40 lines
6. Adapter test stubs MUST fail loudly on wrong argv (gh accepts `#RRGGBB` bare; glab requires leading `#` — per `lesson_origin_ops_pitfalls.md`)
7. Move subprocess-boundary mocks; preserve integration tests
8. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `label-create-github — argv: gh label create (bare-hex color)` | Subprocess-boundary, argv strictness | `lib/adapters/label-create-github.test.ts` |
| `label-create-github — duplicate-lookup fallback on "already exists"` | Idempotency | `lib/adapters/label-create-github.test.ts` |
| `label-create-gitlab — argv: glab api ... (leading-# color)` | Subprocess-boundary, argv strictness | `lib/adapters/label-create-gitlab.test.ts` |
| `label-create-gitlab — duplicate-lookup fallback` | Idempotency | `lib/adapters/label-create-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.labelCreate` signature added [R-01]
- [ ] `lib/adapters/label-create-{github,gitlab}.ts` exist [R-05]
- [ ] Color format enforced per platform (bare-hex GitHub, leading-# GitLab); stubs fail loudly on wrong format
- [ ] `handlers/label_create.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'labelCreate'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.16: Migrate `label_list` (full-migration)

**Wave:** 2.5
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1

Full-migration: smallest handler in the survey (~108 LoC). Trivial lift with color normalization to bare hex in adapter.

**Implementation Steps:**

1. Add `labelList(args: { repo?: string }): Promise<AdapterResult<{ labels: NormalizedLabel[], count: number }>>` to `PlatformAdapter`
2. Create `lib/adapters/label-list-{github,gitlab}.ts` — lift `listGithubLabels` / `listGitlabLabels`
3. Normalize color to bare hex inside each adapter
4. Wire into assemblers; add to `MIGRATED_METHODS`
5. Refactor `handlers/label_list.ts` to ~30 lines
6. Move subprocess-boundary mocks; preserve integration tests
7. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `label-list-github — argv + normalization` | Subprocess-boundary + output | `lib/adapters/label-list-github.test.ts` |
| `label-list-gitlab — argv + normalization` | Subprocess-boundary + output | `lib/adapters/label-list-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.labelList` signature added [R-01]
- [ ] `lib/adapters/label-list-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/label_list.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'labelList'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.17: Migrate `work_item` (full-migration) + close #281

**Wave:** 2.5
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1

Full-migration: today the handler dispatches to one of four create functions (`createGithubIssue` / `createGitlabIssue` / `createGithubPR` / `createGitlabMR`) based on `args.type` with a bug — `createGithubPR` runs on GitLab when `type: 'pr'`, `createGitlabMR` runs on GitHub when `type: 'mr'`. Migration collapses dispatch into one `workItem` adapter method that picks the right gh/glab subcommand internally AND closes #281 with typed asymmetry.

**Implementation Steps:**

1. Add `workItem(args: { type: 'epic'|'story'|'feature'|'chore'|'docs'|'fix'|'pr'|'mr', title: string, body?: string, labels?: string[], head_branch?: string, base_branch?: string, draft?: boolean, repo?: string }): Promise<AdapterResult<{ url: string, number: number }>>` to `PlatformAdapter`
2. Create `lib/adapters/work-item-github.ts` — `type: 'mr'` returns `{platform_unsupported: true, hint: 'use type="pr" on GitHub'}`; `type: 'pr'` creates a PR; other types create an issue
3. Create `lib/adapters/work-item-gitlab.ts` — `type: 'pr'` returns `{platform_unsupported: true, hint: 'use type="mr" on GitLab'}`; `type: 'mr'` creates an MR; other types create an issue
4. Wire into assemblers; add to `MIGRATED_METHODS`
5. Refactor `handlers/work_item.ts` to ~50 lines: validate + dispatch + envelope
6. Close #281 in PR body via `Closes #281`
7. Add regression test for #281: `work_item({type:'pr', ...})` on a GitLab project returns `platform_unsupported` with hint; same for `type:'mr'` on GitHub

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `work-item-github — type:'pr' creates PR via gh pr create` | Happy path | `lib/adapters/work-item-github.test.ts` |
| `work-item-github — type:'mr' returns platform_unsupported` | Regression for #281 | `lib/adapters/work-item-github.test.ts` |
| `work-item-github — issue types create via gh issue create` | Happy path | `lib/adapters/work-item-github.test.ts` |
| `work-item-gitlab — type:'mr' creates MR via glab mr create` | Happy path | `lib/adapters/work-item-gitlab.test.ts` |
| `work-item-gitlab — type:'pr' returns platform_unsupported` | Regression for #281 | `lib/adapters/work-item-gitlab.test.ts` |
| `work-item-gitlab — issue types create via glab issue create` | Happy path | `lib/adapters/work-item-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.workItem` signature added [R-01]
- [ ] `lib/adapters/work-item-{github,gitlab}.ts` exist with typed `platform_unsupported` return for cross-platform type [R-03]
- [ ] `handlers/work_item.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added including #281 regressions [R-15]
- [ ] `'workItem'` in `MIGRATED_METHODS` [R-04]
- [ ] Issue #281 closed via PR
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.18: Migrate `ibm` (+ land `fetchPrForBranch` sub-call)

**Wave:** 2.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 Wave 2.0, 2.1

Hybrid migration: branch-name parsing, protected-branch check, branch-to-issue-number extraction stay in the handler. Two sub-calls are platform-specific: `fetchIssue` (already shipped, Story 2.1) and `fetchPrForBranch` (new).

**Implementation Steps:**

1. Add `fetchPrForBranch(args: { branch: string, state?: 'open'|'closed'|'merged'|'all', repo?: string }): Promise<AdapterResult<{ url: string, number: number } | null>>` to `PlatformAdapter`
2. Create `lib/adapters/fetch-pr-for-branch-{github,gitlab}.ts` — GitHub uses `gh pr list --head <branch> --state <state> --json url,number`; GitLab uses `glab mr list --source-branch <branch>` with state filter
3. Wire into assemblers; add `'fetchPrForBranch'` to `MIGRATED_METHODS`
4. Refactor `handlers/ibm.ts` to call `getAdapter({repo}).fetchIssue(...)` and `getAdapter({repo}).fetchPrForBranch(...)`
5. Delete handler-local `findOpenPr` helper
6. Verify `handlers/ibm.ts` ≤80 lines; no platform branching; no direct subprocess
7. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `fetch-pr-for-branch-github — argv + state filter` | Subprocess-boundary + state translation | `lib/adapters/fetch-pr-for-branch-github.test.ts` |
| `fetch-pr-for-branch-github — null when no matching PR` | Empty-result path | `lib/adapters/fetch-pr-for-branch-github.test.ts` |
| `fetch-pr-for-branch-gitlab — argv + state filter` | Subprocess-boundary + state translation | `lib/adapters/fetch-pr-for-branch-gitlab.test.ts` |
| `fetch-pr-for-branch-gitlab — null when no matching MR` | Empty-result path | `lib/adapters/fetch-pr-for-branch-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.fetchPrForBranch` signature added [R-01]
- [ ] `lib/adapters/fetch-pr-for-branch-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/ibm.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Handler-local `findOpenPr` removed
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'fetchPrForBranch'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.19: Migrate `ci_wait_run` (+ land `ciListRuns` + `resolveBranchSha` sub-calls)

**Wave:** 2.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.18

Hybrid migration: owner of the non-platform polling loop (Phase 0 merge-queue pre-flight, Phase 1 no-run-yet window, Phase 2 poll-until-completed, Phase 3 conclusion normalization). Polling loop stays in the handler or moves to `lib/ci-wait-run-poll.ts`. Platform surface: `ciListRuns` + `resolveBranchSha` (GitHub-only with typed asymmetry on GitLab).

**Implementation Steps:**

1. Add `ciListRuns(args: { ref: string, workflow_name?: string, repo?: string, expected_sha?: string, limit: number }): Promise<AdapterResult<NormalizedRun[]>>` to `PlatformAdapter` (response shape must include `event` for `merge_group` detection and `head_sha` for defense-in-depth filter; GitLab returns `event: null`)
2. Add `resolveBranchSha(args: { branch: string, repo?: string }): Promise<AdapterResult<{ sha: string } | null>>` to `PlatformAdapter` — nullable return on missing branch; collapses `fetchBranchSha` into a single signature per §4-row-8 resolution from the survey
3. Create `lib/adapters/ci-list-runs-{github,gitlab}.ts` (lift `fetchGithubRuns` / `fetchGitlabPipelines`)
4. Create `lib/adapters/resolve-branch-sha-{github,gitlab}.ts` — GitHub: `gh api repos/<slug>/branches/<b> --jq .commit.sha`; GitLab: `{platform_unsupported: true, hint: 'branch→SHA not needed — GitLab CI pipelines attach to branch names directly'}` [R-03]
5. Wire into assemblers; add both methods to `MIGRATED_METHODS`
6. Extract polling loop to `lib/ci-wait-run-poll.ts` (peer of `lib/pr-merge-wait-poll.ts`) with colocated test
7. Refactor `handlers/ci_wait_run.ts` to ~50 lines: validate + dispatch to polling loop + envelope
8. Remove from `scripts/ci/migration-allowlist.txt`

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `ci-list-runs-github — argv + response shape includes event, head_sha` | Subprocess-boundary + shape | `lib/adapters/ci-list-runs-github.test.ts` |
| `ci-list-runs-github — filters by expected_sha` | Argv translation | `lib/adapters/ci-list-runs-github.test.ts` |
| `ci-list-runs-gitlab — event null; head_sha populated` | GitLab shape | `lib/adapters/ci-list-runs-gitlab.test.ts` |
| `resolve-branch-sha-github — argv: gh api ... --jq` | Subprocess-boundary | `lib/adapters/resolve-branch-sha-github.test.ts` |
| `resolve-branch-sha-github — null on missing branch` | Error-path | `lib/adapters/resolve-branch-sha-github.test.ts` |
| `resolve-branch-sha-gitlab — platform_unsupported with hint` | Typed asymmetry [R-03] | `lib/adapters/resolve-branch-sha-gitlab.test.ts` |
| `ci-wait-run-poll — polling loop honors timeout + two-phase window` | Polling correctness | `lib/ci-wait-run-poll.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.ciListRuns` + `PlatformAdapter.resolveBranchSha` added [R-01]
- [ ] `lib/adapters/ci-list-runs-{github,gitlab}.ts` + `lib/adapters/resolve-branch-sha-{github,gitlab}.ts` all exist [R-05]
- [ ] GitLab `resolveBranchSha` returns `platform_unsupported` [R-03]
- [ ] `handlers/ci_wait_run.ts` ≤80 lines; polling loop extracted to `lib/ci-wait-run-poll.ts` [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'ciListRuns'`, `'resolveBranchSha'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.20: Migrate `wave_previous_merged` (+ land `fetchIssueClosure` sub-call)

**Wave:** 2.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.19

Hybrid migration: state-file parsing + deferral filtering stays. Platform surface is the GitHub GraphQL query for `closedByPullRequestsReferences`/`timelineItems` and the GitLab state-only closure fetch.

**Implementation Steps:**

1. Add `fetchIssueClosure(args: { number: number, repo?: string }): Promise<AdapterResult<{ state: 'OPEN'|'CLOSED', closedByMergedPR: boolean }>>` to `PlatformAdapter`
2. Create `lib/adapters/fetch-issue-closure-github.ts` — existing GraphQL query verbatim
3. Create `lib/adapters/fetch-issue-closure-gitlab.ts` — `gitlabApiIssue()` state-only rule per current handler comment
4. Wire into assemblers; add to `MIGRATED_METHODS`
5. Refactor `handlers/wave_previous_merged.ts` to call `getAdapter({repo}).fetchIssueClosure(...)`
6. Delete handler-local `queryIssueClosure` helper
7. Verify ≤80 lines; remove from allowlist

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `fetch-issue-closure-github — GraphQL query argv` | Subprocess-boundary | `lib/adapters/fetch-issue-closure-github.test.ts` |
| `fetch-issue-closure-github — closedByMergedPR:true when closing PR is merged` | Output parsing | `lib/adapters/fetch-issue-closure-github.test.ts` |
| `fetch-issue-closure-github — closedByMergedPR:false when closed without PR` | Edge case | `lib/adapters/fetch-issue-closure-github.test.ts` |
| `fetch-issue-closure-gitlab — argv via gitlabApiIssue + state translation` | Subprocess-boundary | `lib/adapters/fetch-issue-closure-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.fetchIssueClosure` signature added [R-01]
- [ ] `lib/adapters/fetch-issue-closure-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/wave_previous_merged.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Handler-local `queryIssueClosure` removed
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'fetchIssueClosure'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.21: Migrate `wave_reconcile_mrs` (+ land `findMergedPrForBranchPrefix` sub-call) + address #282

**Wave:** 2.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.20

Hybrid migration: state read + per-issue branch-prefix search + `wave-status record-mr` shell-out. Platform surface: prefix-match search. **Addresses #282:** the 50-item client-side scan cap is a known limitation — adapter uses a configurable `limit` argument (default 100; wave caller passes through) and documents the fallback in `docs/adapters/README.md` (Phase 3 Story 3.3).

**Implementation Steps:**

1. Add `findMergedPrForBranchPrefix(args: { prefix: string, limit?: number, repo?: string }): Promise<AdapterResult<{ url: string } | null>>` to `PlatformAdapter`
2. Create `lib/adapters/find-merged-pr-for-branch-prefix-{github,gitlab}.ts` — lift `queryGithubMergedPrs` / `queryGitlabMergedMrs`; use `limit` arg (default 100) instead of hardcoded 50
3. Wire into assemblers; add to `MIGRATED_METHODS`
4. Refactor `handlers/wave_reconcile_mrs.ts` to call the adapter
5. Handler passes `limit` from caller or uses default 100 (addresses the scan-cap concern; documented in adapter README Phase 3)
6. Delete handler-local query helpers
7. Verify ≤80 lines; remove from allowlist
8. Close #282 in PR body via `Closes #282` (addressed via larger limit + documented fallback)

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `find-merged-pr-for-branch-prefix-github — argv + prefix filter` | Subprocess-boundary | `lib/adapters/find-merged-pr-for-branch-prefix-github.test.ts` |
| `find-merged-pr-for-branch-prefix-github — honors limit arg` | Cap configurability | `lib/adapters/find-merged-pr-for-branch-prefix-github.test.ts` |
| `find-merged-pr-for-branch-prefix-github — null when no match within limit` | Fallback return | `lib/adapters/find-merged-pr-for-branch-prefix-github.test.ts` |
| `find-merged-pr-for-branch-prefix-gitlab — argv + prefix filter` | Subprocess-boundary | `lib/adapters/find-merged-pr-for-branch-prefix-gitlab.test.ts` |
| `find-merged-pr-for-branch-prefix-gitlab — honors limit arg` | Cap configurability | `lib/adapters/find-merged-pr-for-branch-prefix-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.findMergedPrForBranchPrefix` signature added [R-01]
- [ ] `lib/adapters/find-merged-pr-for-branch-prefix-{github,gitlab}.ts` exist [R-05]
- [ ] Limit arg honored; default 100 (was hardcoded 50) [bug #282]
- [ ] `handlers/wave_reconcile_mrs.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'findMergedPrForBranchPrefix'` in `MIGRATED_METHODS` [R-04]
- [ ] Issue #282 closed via PR
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.22: Migrate `wave_init` (+ land `createBranch` sub-call; reuses `resolveBranchSha`)

**Wave:** 2.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.21

Hybrid migration: state.json writes + `wave-status` CLI shell-out stay. Platform surface is the KAHUNA branch bootstrap: read `main` HEAD SHA (reuses `resolveBranchSha` from Story 2.19) + create branch (new `createBranch` sub-call).

**Implementation Steps:**

1. Add `createBranch(args: { branch: string, sha: string, repo?: string }): Promise<AdapterResult<void>>` to `PlatformAdapter`
2. Create `lib/adapters/create-branch-{github,gitlab}.ts` — GitHub: `gh api .../git/refs -X POST`; GitLab: `glab api projects/:id/repository/branches -X POST`
3. Wire into assemblers; add to `MIGRATED_METHODS`
4. Refactor `handlers/wave_init.ts` to call `resolveBranchSha('main')` + `createBranch(name, sha)`
5. Delete handler-local `readMainSha` + `createKahunaBranch` helpers
6. `branchExistsOnRemote()` uses `git ls-remote` — stays in `lib/shared/git-remote.ts` (extract if still inline)
7. Verify ≤80 lines; remove from allowlist

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `create-branch-github — argv: gh api .../git/refs POST` | Subprocess-boundary | `lib/adapters/create-branch-github.test.ts` |
| `create-branch-github — void return on success` | Response shape | `lib/adapters/create-branch-github.test.ts` |
| `create-branch-gitlab — argv: glab api branches POST` | Subprocess-boundary | `lib/adapters/create-branch-gitlab.test.ts` |
| `create-branch-gitlab — void return on success` | Response shape | `lib/adapters/create-branch-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.createBranch` signature added [R-01]
- [ ] `lib/adapters/create-branch-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/wave_init.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Handler-local `readMainSha` + `createKahunaBranch` removed
- [ ] `branchExistsOnRemote` in `lib/shared/git-remote.ts` (if it wasn't already)
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'createBranch'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.23: Migrate `wave_finalize` (+ land `findExistingPr` sub-call; reuses `prCreate`)

**Wave:** 2.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.22

Hybrid migration: 509 LoC handler with artifact-tree walker, body composition, SHA hashing, idempotent find-or-create PR flow. Platform surface: `findExistingPr` (new) composed with `prCreate` (Phase 1).

**Implementation Steps:**

1. Add `findExistingPr(args: { head: string, base: string, state: 'open'|'closed'|'merged', repo?: string }): Promise<AdapterResult<NormalizedPr | null>>` to `PlatformAdapter`
2. Create `lib/adapters/find-existing-pr-{github,gitlab}.ts` — generalizes today's `findExistingGithubPr` / `findExistingGitlabMr` with a state enum param
3. Wire into assemblers; add to `MIGRATED_METHODS`
4. Refactor `handlers/wave_finalize.ts` to compose `findExistingPr` with existing `prCreate` adapter (idempotent find-or-create)
5. Promote `assembleBody` and SHA-hashing logic to `lib/wave-finalize.ts` if needed for ≤80-line target
6. Delete handler-local `findExistingGithubPr` / `findExistingGitlabMr` helpers
7. Remove from allowlist

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `find-existing-pr-github — argv + state filter` | Subprocess-boundary | `lib/adapters/find-existing-pr-github.test.ts` |
| `find-existing-pr-github — null when no matching PR` | Empty-result | `lib/adapters/find-existing-pr-github.test.ts` |
| `find-existing-pr-gitlab — argv + state filter` | Subprocess-boundary | `lib/adapters/find-existing-pr-gitlab.test.ts` |
| `find-existing-pr-gitlab — null when no matching MR` | Empty-result | `lib/adapters/find-existing-pr-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template

**Acceptance Criteria:**

- [ ] `PlatformAdapter.findExistingPr` signature added [R-01]
- [ ] `lib/adapters/find-existing-pr-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/wave_finalize.ts` ≤80 lines (after promoting body-assembly helpers if needed); no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Handler-local find helpers removed
- [ ] Removed from allowlist
- [ ] Colocated tests added [R-15]
- [ ] `'findExistingPr'` in `MIGRATED_METHODS` [R-04]
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

#### Story 2.24: Migrate `wave_ci_trust_level` (+ land `fetchCiTrustSignal` sub-call; final migration)

**Wave:** 2.6
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 2.23

Hybrid migration (final Phase 2 story): platform-specific ruleset/branch-protection API calls vs GitLab `merge_trains_enabled` flag. Chose coarse-grained sub-call per survey §3.4 recommendation.

**Implementation Steps:**

1. Add `fetchCiTrustSignal(args: { repo?: string }): Promise<AdapterResult<{ level: 'pre_merge_authoritative'|'post_merge_required'|'unknown', reason: string }>>` to `PlatformAdapter`
2. Create `lib/adapters/fetch-ci-trust-signal-github.ts` — runs ruleset + branch-protection queries; computes trust level
3. Create `lib/adapters/fetch-ci-trust-signal-gitlab.ts` — uses `gitlabApiRepo()` for `merge_trains_enabled`; computes trust level
4. Wire into assemblers; add to `MIGRATED_METHODS`
5. Trust-level cache stays in `handlers/wave_ci_trust_level.ts`; adapter is cache-miss path
6. Refactor handler to call the adapter on cache miss
7. Verify ≤80 lines; remove from allowlist
8. **Confirm `gitlabApi*` importers from `handlers/` tree are zero** — this is the last consumer; grep `handlers/ | grep gitlabApi` should return nothing. Cue for Phase 3 Story 3.1 `lib/glab.ts` deletion.

**Test Procedures:**

*Unit Tests:*

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `fetch-ci-trust-signal-github — ruleset API → pre_merge_authoritative` | Happy path | `lib/adapters/fetch-ci-trust-signal-github.test.ts` |
| `fetch-ci-trust-signal-github — no ruleset → post_merge_required` | Fallback | `lib/adapters/fetch-ci-trust-signal-github.test.ts` |
| `fetch-ci-trust-signal-gitlab — merge_trains_enabled:true → pre_merge_authoritative` | Happy path | `lib/adapters/fetch-ci-trust-signal-gitlab.test.ts` |
| `fetch-ci-trust-signal-gitlab — merge_trains_enabled:false → post_merge_required` | Fallback | `lib/adapters/fetch-ci-trust-signal-gitlab.test.ts` |

*Integration/E2E Coverage:*
- IT-01, IT-04, IT-05 per template
- Final grep: `grep -rE "gitlabApi" handlers/` returns zero lines

**Acceptance Criteria:**

- [ ] `PlatformAdapter.fetchCiTrustSignal` signature added [R-01]
- [ ] `lib/adapters/fetch-ci-trust-signal-{github,gitlab}.ts` exist [R-05]
- [ ] `handlers/wave_ci_trust_level.ts` ≤80 lines; no platform branching; no direct subprocess [R-05, R-09, R-10]
- [ ] Trust-level cache preserved in handler
- [ ] Removed from allowlist — **migration-allowlist.txt is now empty (0 handlers left to migrate)**
- [ ] Colocated tests added [R-15]
- [ ] `'fetchCiTrustSignal'` in `MIGRATED_METHODS` [R-04]
- [ ] Zero `gitlabApi*` importers in `handlers/` tree (final-migration gate for Phase 3 Story 3.1)
- [ ] Integration tests pass [R-11]
- [ ] Gate-greps + contract test + full suite pass

---

### Phase 3: Cleanup, docs, release (Epic)

**Goal:** Delete `lib/glab.ts`, write the adapter-architecture reference doc, supersede the origin-operations guide, tag v1.8.0, and execute the final manual verification gates (MV-05, MV-06) plus VRTM population.

#### Phase 3 Definition of Done

- [ ] `lib/glab.ts` deleted; zero importers in the tree [R-16]
- [ ] `docs/adapters/README.md` exists; documents the `PlatformAdapter` contract, `AdapterResult<T>` shape, file layout, testing strategy, and "where to add a method" workflow [R-13]
- [ ] `docs/handlers/origin-operations-guide.md` §2.4 rewritten with supersession note pointing to `docs/adapters/README.md` [R-14]
- [ ] Root `README.md` has a new "Adapter architecture" section
- [ ] `v1.8.0` tagged and released; `install-remote.sh` picks up the new binary
- [ ] MV-05 executed and PASSED (grep handlers/ returns zero platform-branch + zero direct subprocess)
- [ ] MV-06 executed and PASSED (`/precheck` + `/scpmmr` smoke tests on v1.8.0)
- [ ] VRTM (Appendix V) populated with verification entries for all 17 requirements
- [ ] `scripts/ci/migration-allowlist.txt` is empty or deleted (gate-greps now globally-applied to `handlers/`)
- [ ] CHANGELOG / GitHub release notes on the v1.8.0 tag summarize the full retrofit
- [ ] Full suite passes

---

### Wave Map (Phase 3)

```
PHASE 3 — Cleanup + docs + release
───────────────────────────────────
Wave 3.1  ─── Story 3.1: Delete lib/glab.ts
                  │
Wave 3.2  ─┬─ Story 3.2: Rewrite origin-operations-guide §2.4
            └─ Story 3.3: Write docs/adapters/README.md         (2 parallel — disjoint docs)
                  │
Wave 3.3  ─── Story 3.4: Update root README.md
                  │
Wave 3.4  ─── Story 3.5: Tag v1.8.0 + release notes
                  │
Wave 3.5  ─── Story 3.6: Phase 3 closing — MV-05 + MV-06 + VRTM
```

| Wave | Stories | Master Issue | Parallel? |
|------|---------|-------------|-----------|
| 3.1 | 3.1 | Story 3.1 | Single story (deletion) |
| 3.2 | 3.2, 3.3 | Wave 3.2 Master | Yes — 2 parallel |
| 3.3 | 3.4 | Story 3.4 | Single story |
| 3.4 | 3.5 | Story 3.5 | Single story (release) |
| 3.5 | 3.6 | Story 3.6 | Single story (closing) |

---

#### Story 3.1: Delete `lib/glab.ts`

**Wave:** 3.1
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Phase 2 complete (Story 2.24 confirmed zero `gitlabApi*` importers in `handlers/`)

Remove `lib/glab.ts` — the `gitlabApi*` helpers it exports have been fully consumed by adapter migrations and have no remaining importers.

**Implementation Steps:**

1. Run `grep -rnE "from ['\"].*lib/glab['\"]|gitlabApi[A-Z]" lib/ handlers/` — confirm zero importers outside `lib/adapters/` (adapter files may still import for transitional reasons; this story resolves them)
2. Move any remaining `gitlabApi*` helper implementations still needed by adapters into the relevant `lib/adapters/*-gitlab.ts` file, inlined
3. Delete `lib/glab.ts`
4. Remove `lib/glab.test.ts` if it exists
5. Confirm `tsc --noEmit` passes
6. Run full suite

**Test Procedures:**

*Unit Tests:* none new — existing adapter tests inherit the inlined helpers.

*Integration/E2E Coverage:*
- IT-04 — full suite passes post-deletion [R-11]
- Direct grep: `grep -rn "lib/glab" .` returns zero hits

**Acceptance Criteria:**

- [ ] `lib/glab.ts` file absent [R-16]
- [ ] `lib/glab.test.ts` absent (if it existed)
- [ ] Zero importers of `lib/glab` across the repo
- [ ] `tsc --noEmit` passes
- [ ] Full suite passes [R-11]
- [ ] Gate-greps + contract test pass

---

#### Story 3.2: Rewrite `docs/handlers/origin-operations-guide.md` §2.4 with supersession note

**Wave:** 3.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 3.1

Update the Origin Operations guide to reflect the new architecture. §2.4 previously documented the inline platform-branching convention; it must now point consumers to `docs/adapters/README.md` and flag that inline branching is gate-grep-enforced off-limits.

**Implementation Steps:**

1. Open `docs/handlers/origin-operations-guide.md` §2.4
2. Replace the inline-convention prose with a short "Superseded — see `docs/adapters/README.md`" note that preserves section numbering but redirects to the new doc
3. Add a summary: every new platform-aware operation now adds a method to `PlatformAdapter` interface + impls in both `lib/adapters/*-{github,gitlab}.ts` files; handlers must not branch on platform or shell out directly
4. Cross-link to `scripts/ci/gate-greps.sh` with a note that CI enforces this

**Test Procedures:**

*Unit Tests:* none (docs-only).

*Integration/E2E Coverage:*
- Manual review — a future reader lands on §2.4 and finds the right entry point
- Link check: internal references resolve

**Acceptance Criteria:**

- [ ] `docs/handlers/origin-operations-guide.md` §2.4 rewritten with supersession note [R-14]
- [ ] Internal link to `docs/adapters/README.md` present
- [ ] Internal link to `scripts/ci/gate-greps.sh` present
- [ ] No orphan references to the old inline convention elsewhere in the doc

---

#### Story 3.3: Write `docs/adapters/README.md`

**Wave:** 3.2
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 3.1

Author the canonical adapter-architecture reference. Target audience: maintainers adding a new method, fixing a platform bug, or auditing a method's cross-platform behavior.

**Implementation Steps:**

1. Create `docs/adapters/README.md` with sections:
   - **1. The Contract** — `PlatformAdapter` interface + `AdapterResult<T>` discriminated union; copy TypeScript signatures verbatim from `lib/adapters/types.ts`
   - **2. File Layout** — `lib/adapters/*.ts` (interface, route, index, per-method pairs); `lib/shared/*.ts`; handler file structure; colocated test convention
   - **3. Dispatch Model** — `getAdapter({repo})` cwd-based `detectPlatform()`; how a handler uses the adapter
   - **4. Typed Asymmetries** — `platform_unsupported: true` pattern with examples from `pr_merge skip_train`, `work_item type cross-platform`, `resolve-branch-sha-gitlab`
   - **5. Where to add a new method** — step-by-step: add signature to `types.ts`, create `<method>-{github,gitlab}.ts` pair, wire into assemblers, add to `MIGRATED_METHODS`, write colocated tests
   - **6. Gate-greps** — what they enforce, how to regenerate the allowlist, what the `scripts/ci/migration-allowlist.txt` file does
   - **7. Hybrid handlers + sub-calls** — when a handler owns non-platform orchestration (state files, markdown parsers, polling loops), extract only the platform sub-call; reference `fetchPrState` + `fetchIssue` as exemplars
   - **8. Testing** — subprocess-boundary mocks; contract test; integration tests preservation; `lesson_origin_ops_pitfalls.md` on argv strictness
   - **9. Cross-reference** — Dev Spec, VRTM, `docs/adapters/survey.md`

2. Include a "no server-side prefix filter? fall back to generous limit + client filter" example (per survey §5.5 #2)

**Test Procedures:**

*Unit Tests:* none (docs-only).

*Integration/E2E Coverage:*
- Manual review for completeness
- Link check: all internal references resolve
- Fresh-reader test: a maintainer with no retrofit context can add a new method using only this doc

**Acceptance Criteria:**

- [ ] `docs/adapters/README.md` exists with all 9 sections [R-13]
- [ ] Every `PlatformAdapter` method from `types.ts` is listed (can be scripted)
- [ ] "Where to add a new method" is a complete, numbered procedure
- [ ] Gate-greps documented with file:line pointer to `scripts/ci/gate-greps.sh`
- [ ] Typed-asymmetry pattern documented with ≥3 concrete examples
- [ ] Hybrid sub-call pattern documented with ≥2 exemplars

---

#### Story 3.4: Update root `README.md` with adapter architecture section

**Wave:** 3.3
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 3.3

Surface the adapter architecture at the project root. A one-paragraph summary + link to `docs/adapters/README.md`.

**Implementation Steps:**

1. Open root `README.md`
2. Add a new section near the top (after "Overview", before "Installation") titled "Adapter architecture"
3. Write 2-3 paragraphs: what the adapter pattern gives the project, where to find the contract doc, how the gate-greps enforce it, and the canonical exemplar file (`lib/adapters/pr-merge-{github,gitlab}.ts` per R-03)
4. Cross-link to `docs/adapters/README.md`

**Test Procedures:**

*Unit Tests:* none (docs-only).

*Integration/E2E Coverage:*
- Manual review: renders correctly on GitHub; links resolve

**Acceptance Criteria:**

- [ ] Root `README.md` has a new "Adapter architecture" section [DM-01]
- [ ] Section links to `docs/adapters/README.md`
- [ ] Canonical exemplar files named
- [ ] Existing `README.md` sections unmodified unless directly adjacent

---

#### Story 3.5: Tag `v1.8.0` + write release notes

**Wave:** 3.4
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Stories 3.2, 3.3, 3.4

Create the `v1.8.0` release. CI builds the binaries via existing `release.yml`. Release notes summarize the retrofit as a single coherent shipment.

**Implementation Steps:**

1. Verify `main` is green (full suite + gate-greps)
2. Draft release notes covering:
   - High-level summary: "Internal refactor — platform adapter retrofit. All 25 platform-aware handlers migrated to `PlatformAdapter`; gate-greps prevent regression."
   - What users see: "No behavioral changes. `lib/glab.ts` removed from exports (internal-only change)."
   - Links: Dev Spec, `docs/adapters/README.md`, survey, VRTM
   - Statistics: `MIGRATED_METHODS` 10/25 → 27/27, `migration-allowlist.txt` 31 → 0, test suite 1466 → final count
3. Tag via `git tag -a v1.8.0 -m "Platform adapter retrofit — see release notes"` then `git push origin v1.8.0`
4. `release.yml` triggers; verify the release draft on GitHub
5. Publish the release (attach the binaries produced by CI per DM-07)

**Test Procedures:**

*Unit Tests:* none (release-only).

*Integration/E2E Coverage:*
- Manual: `install-remote.sh` with `SDLC_VERSION=v1.8.0` installs the new binary cleanly
- Smoke: Claude Code restarted with v1.8.0 can run basic tool calls (covered by MV-06 in Story 3.6)

**Acceptance Criteria:**

- [ ] `v1.8.0` tag exists on `main`
- [ ] GitHub release published with release notes and platform binaries attached [DM-07]
- [ ] Release notes link to Dev Spec + survey + adapter README
- [ ] `install-remote.sh` installs v1.8.0 without error on a test machine

---

#### Story 3.6: Phase 3 Closing — MV-05, MV-06, VRTM

**Wave:** 3.5
**Repository:** `Wave-Engineering/mcp-server-sdlc`
**Dependencies:** Story 3.5

Final closing: execute MV-05 and MV-06 from §6.4; populate Appendix V VRTM with one verification entry per requirement (R-01 through R-17).

**Implementation Steps:**

1. **MV-05 — grep handlers/ for platform branching and direct subprocess:**
   - Run `grep -rnE "platform === '(github|gitlab)'" handlers/` — expect zero matches
   - Run `grep -rnE "execSync\(['\"\`](gh|glab) |Bun\.spawnSync" handlers/` — expect zero matches
   - Record results on the closing issue
2. **MV-06 — v1.8.0 smoke test:**
   - Install v1.8.0 via `install-remote.sh`
   - Restart Claude Code; run `/precheck` on a small PR candidate in this repo — verify it completes without error
   - Run `/scpmmr` on a small PR candidate — verify it completes without error
   - Record results on the closing issue
3. **VRTM population (Appendix V):**
   - For each of R-01 through R-17: add the verification status (Passing/Deferred) and the verification item(s) — PR SHAs, story issue numbers, test-file names, MV entries
   - Fill the "Status" column for every row; "Pending" entries become "Verified" with evidence or "Deferred" with rationale (MV-01 already)
4. **Close the Phase 3 epic** with the MV-05/MV-06 results and the populated VRTM

**Test Procedures:**

*Unit Tests:* none (verification + tracing only).

*Integration/E2E Coverage:*
- MV-05 greps per §6.4
- MV-06 smoke tests per §6.4

**Acceptance Criteria:**

- [ ] MV-05 executed and PASSED (both greps return zero matches)
- [ ] MV-06 executed and PASSED (`/precheck` + `/scpmmr` on v1.8.0 complete without error)
- [ ] Appendix V VRTM populated: every R-XX row has Status = Verified or Deferred (with rationale)
- [ ] Closing issue documents every MV result with evidence (timestamps, command output, PR URLs)
- [ ] Phase 3 epic closed via the closing story PR
- [ ] Retrofit marked complete

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
| R-11 | Backward-compatible behavior | All migration stories | IT-04, ~~MV-01~~ (deferred — see §6.4), MV-06 | regression suite + manual | Pending |
| R-12 | Subprocess style normalized | Story 1.1 | Story 1.1 AC | inspection + test | Pending |
| R-13 | docs/adapters/README.md exists | Phase 3 Story 3.3 | Story 3.3 AC | inspection | Pending |
| R-14 | §2.4 rewritten with supersession | Phase 3 Story 3.2 | Story 3.2 AC | inspection | Pending |
| R-15 | Colocated adapter test files | All migration stories | Per-story AC | inspection + suite run | Pending |
| R-16 | lib/glab.ts deleted | Phase 3 Story 3.1 | Story 3.1 AC | inspection (file absent) | Pending |
| R-17 | Helpers moved to lib/shared/ | Story 1.2 + Phase 3 cleanup | Story 1.2 AC + final inspection | inspection | Pending |
