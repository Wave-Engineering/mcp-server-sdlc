# Phase 1 Adapter Retrofit — Survey

**Status:** Phase 1 deliverable (Story 1.12, issue #249)
**Input to:** Phase 2 `/devspec` re-run; binding Section 8 wave plan
**Cross-refs:** `docs/platform-adapter-retrofit-devspec.md` §5.1, §5.5, §8; `lib/adapters/types.ts`; `scripts/ci/migration-allowlist.txt`

---

## 1. Scope

Classify every platform-aware handler that remains in `scripts/ci/migration-allowlist.txt` post-Phase-1 canary. Each entry is tagged **full-migration** (entirely platform-specific body → one adapter method-pair) or **hybrid** (state-aware / markdown-aware / filesystem-aware shell → adapter is one or more narrow sub-calls). For hybrids, the needed sub-calls are named and signed so Phase 2 can aggregate.

### 1.1 Count reconciliation

The Dev Spec (§5.5, §5.N, Wave Map) uses "22 remaining handlers" for the post-Phase-1 rollover. The on-disk `migration-allowlist.txt` lists **23**. The one-off (`wave_ci_trust_level.ts`) was added to the allowlist after the Dev Spec was frozen; it is a genuine platform-aware handler and is included here. Total surveyed: **23**.

### 1.2 Already-shipped canary context (recap, not re-surveyed)

| Story | Handler | Adapter pair | Migrated-methods truth |
|-------|---------|--------------|------------------------|
| 1.3 | `pr_create` | `pr-create-{github,gitlab}.ts` | `prCreate` |
| 1.4 | `pr_diff` | `pr-diff-{github,gitlab}.ts` | `prDiff` |
| 1.5 | `pr_files` | `pr-files-{github,gitlab}.ts` | `prFiles` |
| 1.6 | `pr_list` | `pr-list-{github,gitlab}.ts` | `prList` |
| 1.7 | `pr_status` | `pr-status-{github,gitlab}.ts` | `prStatus` |
| 1.8 | `pr_comment` | `pr-comment-{github,gitlab}.ts` | `prComment` |
| 1.9 | `pr_wait_ci` | `pr-wait-ci-{github,gitlab}.ts` | `prWaitCi` |
| 1.10 | `pr_merge` | `pr-merge-{github,gitlab}.ts` | `prMerge` (typed `platform_unsupported` for `skip_train`) |
| 1.11 | `pr_merge_wait` | `pr-merge-wait-{github,gitlab}.ts` + `fetch-pr-state-{github,gitlab}.ts` | `prMergeWait`, `fetchPrState` (**first hybrid sub-call**) |

`lib/adapters/types.test.ts::MIGRATED_METHODS` is 10/25 at survey time. The 15 still-stubbed methods and their target handlers are the subject of this survey.

---

## 2. Methodology

For each handler the survey answers three questions:

1. **What platform-specific work does it do?** Tag the subprocess calls (`gh`, `glab`, `gh api`, `glab api`, `gitlabApi*` helpers) and the `if (platform === 'github')` branches.
2. **Is the non-platform logic substantial?** If platform code is >50% of the handler's total LoC and has no non-platform orchestration around it → **full-migration** (lift the whole handler into an adapter pair; handler becomes a ~50-line dispatch wrapper per the §5.4 template). If the handler wraps platform calls with markdown parsing, state-file I/O, or ref-resolution that cannot meaningfully move platform-side → **hybrid** (extract only the platform sub-call; handler keeps its orchestration).
3. **What sub-call signatures does it need?** Each hybrid entry proposes a typed sub-call. Sub-calls that appear across multiple handlers get aggregated in §4.

---

## 3. Per-handler classification

### 3.1 CI family (5 handlers)

#### `ci_failed_jobs.ts` — **full-migration**
- Whole handler is a thin platform wrapper: `fetchGithubFailedJobs()` calls `gh run view <id> --json jobs`; `fetchGitlabFailedJobs()` calls `glab api projects/:id/pipelines/<id>/jobs`. Both normalize into `FailedJob[]`. Dispatch is a 2-line `platform === 'github' ? ... : ...` branch.
- Lift verbatim into `ci-failed-jobs-{github,gitlab}.ts`. Adapter method `ciFailedJobs(args: { run_id, repo? }) → AdapterResult<{ failed_jobs: FailedJob[] }>`.
- Handler shrinks to ~40 lines (validate + dispatch + envelope).

#### `ci_run_logs.ts` — **full-migration**
- Handler body is `fetchGithub()` (gh run view --log / --log-failed) vs `fetchGitlab()` (glab api to find failed job + `glab ci trace`). Truncation helper `truncateLogs()` is platform-agnostic and stays in `lib/shared/truncate-logs.ts` (new).
- Adapter method `ciRunLogs(args) → AdapterResult<{ logs, job_id, url }>` returns the raw-fetched payload; truncation is composed in the handler against the adapter result.
- Note: `parseRepoSlug()` already moved to `lib/shared/` — adapters should import from there.

#### `ci_run_status.ts` — **full-migration**
- `ghQueryRuns()` / `glQueryRuns()` are the platform calls; `normalizeGh()` / `normalizeGl()` fold into adapter response. Status/conclusion enum mapping belongs with each platform adapter (it's platform-shape-to-normalized-shape glue — the same category of work that `pr-status-gitlab.ts` does today).
- Adapter method `ciRunStatus(args: { ref, workflow_name?, repo? }) → AdapterResult<NormalizedRun | null>`.
- The handler already imports `gitlabApiCiList` from `lib/glab.ts`; migration moves that call into `ci-run-status-gitlab.ts` (consistent with R-16).

#### `ci_runs_for_branch.ts` — **full-migration**
- Same shape as `ci_run_status`: platform-specific status-flag translation (`githubStatusFlag` / `gitlabStatusFlag`), platform-specific list queries, and platform-specific normalization. No state or markdown surface.
- Adapter method `ciRunsForBranch(args: { branch, limit, status, repo? }) → AdapterResult<{ runs: RunRecord[] }>`.

#### `ci_wait_run.ts` — **hybrid** (sub-calls: `ciListRuns`, optionally `resolveBranchSha` on GitHub)
- 622 LoC; the handler owns a non-platform polling loop (Phase 0 merge-queue pre-flight, Phase 1 no-run-yet window, Phase 2 poll-until-completed, Phase 3 conclusion normalization). That orchestration stays in the handler (or moves to `lib/ci-wait-run-poll.ts` as a peer to `lib/pr-merge-wait-poll.ts`).
- Platform-specific work: `fetchGithubRuns` (gh run list with expected_sha/workflow filters), `fetchGitlabPipelines` (gitlabApiCiList), and the GitHub-only `resolveBranchToSha` (used by the merge-queue pre-flight).
- Proposed sub-calls:
  - `ciListRuns(args: { ref, workflow_name?, repo?, expected_sha?, limit }) → AdapterResult<NormalizedRun[]>` — the returned shape must expose `event` (for `merge_group` detection) and `head_sha` (for defense-in-depth filtering). GitLab's shape has no `event`; the field is `null` on GitLab.
  - `resolveBranchSha(args: { branch, repo }) → AdapterResult<{ sha: string } | null>` — GitHub-only in practice; GitLab returns `{ platform_unsupported: true, hint: 'branch→SHA not needed — GitLab CI pipelines attach to branch names directly' }`. Typed asymmetry; same pattern as `skip_train` on GitLab.
- Rationale for hybrid: the polling loop is ~250 LoC of stateful non-platform logic (sleep injection, timeout accounting, two-phase window, merge-queue fast-path). Lifting it into each adapter doubles the logic — the same mistake `pr_merge_wait` avoided by keeping `pollUntilMerged` in `lib/`.

---

### 3.2 Label & work-item family (5 handlers)

#### `label_create.ts` — **full-migration**
- Handler is create-with-idempotent-duplicate-fallback: `createGithubLabel()` (gh label create) with `lookupGithubLabel()` fallback on "already exists"; same shape on GitLab. Platform-specific color normalization (`#RRGGBB` vs bare hex) lives entirely in each platform function.
- Adapter method `labelCreate(args) → AdapterResult<NormalizedLabel>` where the adapter handles the duplicate-lookup internally. The handler becomes a ~40-line dispatcher.
- Memory `lesson_origin_ops_pitfalls.md` applies: test stubs MUST fail loudly on wrong argv (gh accepts `#RRGGBB` bare; glab requires leading `#`).

#### `label_list.ts` — **full-migration**
- Smallest handler (108 LoC). `listGithubLabels()` / `listGitlabLabels()`, color normalization to bare hex. Trivial lift.
- Adapter method `labelList(args) → AdapterResult<{ labels: NormalizedLabel[], count }>`.

#### `work_item.ts` — **full-migration**
- Dispatches to one of four create functions (`createGithubIssue`, `createGitlabIssue`, `createGithubPR`, `createGitlabMR`) based on `args.type`. The `type → platform-op` table is shared logic; the CLI invocation per branch is platform-specific.
- Adapter method (one, not four): `workItem(args: { type: 'epic'|'story'|...|'pr'|'mr', title, body?, labels?, head_branch?, base_branch?, draft? }) → AdapterResult<{ url: string, number: number }>`. The adapter picks the right gh/glab subcommand internally; the handler stays at ~50 LoC.
- Cross-platform asymmetry: `type: 'pr'` on GitLab → `platform_unsupported: true, hint: 'use type="mr" on GitLab'`. Same for `type: 'mr'` on GitHub. Today the handler has a subtle bug: it calls `createGithubPR` for `type: 'pr'` regardless of platform, and `createGitlabMR` for `type: 'mr'` regardless of platform — which produces a "gh not found" or "glab not found" error rather than a typed signal. Migration should close that gap. Worth opening a follow-up issue before Phase 2 kicks off.

#### `ibm.ts` — **hybrid** (sub-calls: `fetchIssue`, `fetchPrForBranch`)
- Branch-name parsing, protected-branch check, branch-to-issue-number extraction are all platform-agnostic. Two sub-calls are platform-specific: get issue by number, find open PR/MR by head branch.
- Proposed sub-calls (both shared across family):
  - `fetchIssue(args: { number, repo? }) → AdapterResult<{ number, title, state: 'OPEN'|'CLOSED', url, body, labels }>` — the canonical sub-call referenced by the Dev Spec §5.1 as the illustrative hybrid example. Used by `ibm`, `spec_get`, `spec_validate_structure`, `spec_acceptance_criteria`, `spec_dependencies`, `epic_sub_issues`, `wave_compute`, `wave_dependency_graph`, `wave_topology`, `dod_load_manifest`. **Widest-reach sub-call in the survey.**
  - `fetchPrForBranch(args: { branch, state?, repo? }) → AdapterResult<{ url: string, number: number } | null>` — used by `ibm` (find any PR) and potentially `wave_reconcile_mrs` (find merged PR, different state filter). Decide during Phase 2 whether to unify into one sub-call with a state filter or keep two.

#### `epic_sub_issues.ts` — **hybrid** (sub-call: `fetchIssue`)
- Handler body is 200 LoC of markdown table / checklist parsing (`parseTableRows`, `parseChecklistOrBullets`, `normalizeRef`). The ONLY platform surface is `fetchBody()` — the same gh-issue-view-json-body / gitlabApiIssue-description pattern as the spec_* family.
- Extract `fetchIssue` (same sub-call as `ibm`). Handler keeps the markdown machinery in full.

---

### 3.3 Spec family (4 handlers)

All four spec handlers share the identical `fetchBody(ref: IssueRef): string` helper — ~10 lines of platform branching. The bodies are parsed through `lib/spec_parser` (already platform-agnostic). No sub-call other than `fetchIssue` is needed.

#### `spec_get.ts` — **hybrid** (sub-call: `fetchIssue`)
- Fetches issue body + title + state + labels, parses via `parseSections`. The richest consumer of `fetchIssue` (needs more fields than just the body).
- Drives the sub-call's response shape (state, labels, title, body all required).

#### `spec_validate_structure.ts` — **hybrid** (sub-call: `fetchIssue`)
- Fetches body only; checks for required/optional H2 sections. Thin wrapper over `fetchIssue(body-only)`.

#### `spec_acceptance_criteria.ts` — **hybrid** (sub-call: `fetchIssue`)
- Fetches body, parses checklist items via regex. Thin wrapper.

#### `spec_dependencies.ts` — **hybrid** (sub-call: `fetchIssue`)
- Fetches body, parses `## Dependencies` section + bold-label fallback. Thin wrapper.

**Spec-family note:** all 4 handlers call `fetchIssue` and nothing else platform-specific. Grouping them into one wave is efficient — once `fetchIssue` lands, all 4 handler migrations are near-mechanical (remove `fetchBody`, route via `getAdapter().fetchIssue()`, keep the markdown parser).

---

### 3.4 Wave family (8 handlers)

The wave family is the messiest. Several handlers (`wave_init`, `wave_finalize`, `wave_reconcile_mrs`, `wave_previous_merged`, `wave_ci_trust_level`) have both **wave-state file I/O** and **platform calls**. State I/O stays in `handlers/`; platform calls move to adapters. None are pure full-migration candidates.

#### `wave_ci_trust_level.ts` — **hybrid** (sub-calls: `fetchRulesetList`, `fetchRuleset`, `fetchBranchProtection`, `fetchRepoMeta`)
- Platform-specific API calls for ruleset detection (GitHub: `/repos/.../rulesets`, `/rulesets/<id>`; branch protection: `/branches/main/protection`) vs GitLab `gitlabApiRepo()` for `merge_trains_enabled`. Trust-level computation logic + cache are platform-agnostic.
- Sub-call proposals:
  - `fetchRulesetList(args: { repo? }) → AdapterResult<{ id: number, enforcement?: string }[]>` — GitHub-specific meaning; GitLab returns `platform_unsupported: true, hint: 'rulesets are a GitHub concept; use fetchRepoMeta.merge_trains_enabled on GitLab'`.
  - `fetchRuleset(args: { id, repo? }) → AdapterResult<{ rules: { type?: string }[] }>` — same asymmetry.
  - `fetchBranchProtection(args: { branch, repo? }) → AdapterResult<{ strict?: boolean }>` — GitHub-specific.
  - `fetchRepoMeta(args: { repo? }) → AdapterResult<{ merge_trains_enabled?: boolean, ... }>` — pull from `gitlabApiRepo()` on GitLab; GitHub returns platform-native metadata (no merge-train concept).
- **Alternative:** collapse this into one coarse-grained `fetchCiTrustSignal(args) → AdapterResult<TrustResult>` sub-call. That's arguably a **full-migration** dressed as hybrid, since the trust-level enum values and cache contract survive. Recommendation (Phase 2 decision): prefer the coarse-grained sub-call — the fine-grained rulesets API is a GitHub-implementation detail, not a useful cross-cutting adapter boundary. Record the fine-grained options if they get reused by a future handler.

#### `wave_compute.ts` — **hybrid** (sub-call: `fetchIssue`)
- 356 LoC — large handler, but the ONLY platform surface is `fetchIssue(ref)` (imported as local `fetchIssue`, identical gh-pattern / gitlabApiIssue-pattern). All the wave computation, sub-issue parsing, dependency parsing, and the story-self fallback are platform-agnostic.
- Thin hybrid; mechanical migration once `fetchIssue` lands.

#### `wave_dependency_graph.ts` — **hybrid** (sub-call: `fetchIssue`)
- 215 LoC; identical fetchIssue pattern + dependency parsing (already nearly a duplicate of `wave_compute`'s helpers). Mechanical migration.

#### `wave_topology.ts` — **hybrid** (sub-call: `fetchIssue`)
- 237 LoC; same shape as `wave_dependency_graph`. Mechanical migration.

#### `wave_init.ts` — **hybrid** (sub-calls: `fetchBranchSha`, `createBranch`)
- 451 LoC; owns state.json write and `wave-status` CLI shell-out (stays in handler — not platform code). Platform surface is the KAHUNA branch bootstrap: read `main` HEAD SHA + create branch.
- Sub-call proposals:
  - `fetchBranchSha(args: { branch, repo? }) → AdapterResult<{ sha: string }>` — GitHub: `gh api repos/<slug>/branches/<b> --jq .commit.sha`; GitLab: `glab api projects/<id>/repository/branches/<b>` + parse `commit.id`. Same concept, two different encodings.
  - `createBranch(args: { branch, sha, repo? }) → AdapterResult<void>` — GitHub: `gh api .../git/refs -X POST`; GitLab: `glab api .../repository/branches -X POST`. Straightforward.
- The `branchExistsOnRemote()` helper uses `git ls-remote` — not platform-CLI — so it stays in `lib/shared/git-remote.ts` (or inline).

#### `wave_finalize.ts` — **hybrid** (sub-calls: `findExistingPr`, `createPr`, `branchExistsOnRemote`)
- 509 LoC; massive handler with artifact-tree walker (`assembleBody`), body composition, SHA hashing, and idempotent find-or-create PR flow. All non-platform except the PR find + create.
- Sub-call proposals (these are also used by other handlers — see aggregation):
  - `findExistingPr(args: { head, base, state: 'open' | 'merged' | 'closed', repo? }) → AdapterResult<NormalizedPr | null>` — generalizes today's `findExistingGithubPr` / `findExistingGitlabMr`. `wave_reconcile_mrs` uses a state=`merged` variant; `wave_finalize` uses state=`open`. **One sub-call, one state enum param.**
  - `createPr(args: { title, body, head, base, repo? }) → AdapterResult<NormalizedPr>` — simpler signature than `prCreate` (no `draft`, no `squash_message` churn); wave_finalize only needs title+body+head+base. **Open question for Phase 2:** reuse `prCreate` from canary or introduce a separate `createPr` for the idempotent path? Recommendation: reuse `prCreate`; add a `findExistingPr` sub-call and let `wave_finalize` compose `findExistingPr || prCreate`. Reuse wins.
  - `branchExistsOnRemote` — uses `git ls-remote`; not a platform-CLI adapter sub-call. Stays in `lib/shared/`.

#### `wave_previous_merged.ts` — **hybrid** (sub-call: `fetchIssueClosure`)
- 333 LoC; owns state file parsing + deferral filtering. Platform surface is the GitHub GraphQL query for `closedByPullRequestsReferences` / `timelineItems` and the GitLab simpler issue-state fetch.
- Sub-call proposal:
  - `fetchIssueClosure(args: { number, repo? }) → AdapterResult<{ state: 'OPEN' | 'CLOSED', closedByMergedPR: boolean }>` — narrower than `fetchIssue` (only closure info). GitHub impl runs the existing GraphQL query verbatim; GitLab impl uses `gitlabApiIssue()` with the documented state-only closure rule from today's handler.
  - The Dev Spec §5.5 explicitly calls out `fetchIssueClosure` as a canonical hybrid example — this is the story that lands it.

#### `wave_reconcile_mrs.ts` — **hybrid** (sub-call: `findMergedPrForBranchPrefix`)
- 240 LoC; state read + per-issue branch-prefix search + `wave-status record-mr` shell-out. Platform surface is `queryGithubMergedPrs(issueNumber)` (gh pr list --state merged + prefix filter) / `queryGitlabMergedMrs` (glab mr list --state merged + prefix filter).
- Sub-call proposal:
  - `findMergedPrForBranchPrefix(args: { prefix: string, repo? }) → AdapterResult<{ url: string } | null>` — a specialized finder. Today's handler fetches 50 merged PRs then client-side-filters; the adapter could do the same (both CLIs lack a server-side prefix filter).
- **Alternative:** reuse the generalized `findExistingPr(state: 'merged')` with a branch-prefix match shape — but `findExistingPr` assumes exact `head` branch, not prefix. Recommendation (Phase 2): keep `findMergedPrForBranchPrefix` as a distinct sub-call; its semantics (branch-name prefix matching) diverge from find-existing-by-exact-branch.

---

### 3.5 DoD (1 handler)

#### `dod_load_manifest.ts` — **hybrid** (sub-call: `fetchIssue`)
- 215 LoC; markdown manifest extraction + table parsing are platform-agnostic. Platform surface is `fetchIssueBody(ref)` — same pattern as spec_* / epic_sub_issues, though with a stricter argument vocabulary (accepts `#N` or `org/repo#N` only).
- `fetchIssue` sub-call covers this.

---

## 4. Aggregated `PlatformAdapter` sub-call list

Sub-calls proposed across all hybrid handlers, deduplicated. Each entry: name, TypeScript signature, consumer handlers.

| # | Sub-call | Signature | Used by (handlers) | Notes |
|---|----------|-----------|---------------------|-------|
| 1 | `fetchIssue` | `(args: { number: number, repo?: string }) → AdapterResult<{ number, title, state: 'OPEN'\|'CLOSED', url, body, labels: string[] }>` | `ibm`, `spec_get`, `spec_validate_structure`, `spec_acceptance_criteria`, `spec_dependencies`, `epic_sub_issues`, `wave_compute`, `wave_dependency_graph`, `wave_topology`, `dod_load_manifest` (10 handlers) | Widest-reach sub-call. Phase 2 Wave Zero candidate — once this lands, 10 handler migrations become near-mechanical. `spec_get` is the shape-driver (needs all fields). |
| 2 | `fetchIssueClosure` | `(args: { number: number, repo?: string }) → AdapterResult<{ state: 'OPEN'\|'CLOSED', closedByMergedPR: boolean }>` | `wave_previous_merged` (1 handler) | GitHub impl: existing GraphQL query. GitLab impl: state-only per current handler comment. |
| 3 | `fetchPrForBranch` | `(args: { branch: string, state?: 'open'\|'closed'\|'merged'\|'all', repo?: string }) → AdapterResult<{ url: string, number: number } \| null>` | `ibm` (state='open'), potentially `wave_reconcile_mrs` (state='merged', but with prefix match) | See §3.2/§3.4 decision: keep `findMergedPrForBranchPrefix` separate for now; revisit unification in Phase 2 after implementation. |
| 4 | `findMergedPrForBranchPrefix` | `(args: { prefix: string, repo?: string }) → AdapterResult<{ url: string } \| null>` | `wave_reconcile_mrs` (1 handler) | Prefix-match search; both platforms lack a server-side filter, so client-side 50-item scan is unavoidable. |
| 5 | `findExistingPr` | `(args: { head: string, base: string, state: 'open'\|'closed'\|'merged', repo?: string }) → AdapterResult<NormalizedPr \| null>` | `wave_finalize` (1 handler; composes with `prCreate`) | Reuses the `NormalizedPr` shape from `prList`. |
| 6 | `ciListRuns` | `(args: { ref: string, workflow_name?: string, repo?: string, expected_sha?: string, limit: number }) → AdapterResult<NormalizedRun[]>` | `ci_wait_run` (1 handler; polling loop stays in handler/lib) | Response must include `event` (for `merge_group` detection) and `head_sha` (defense-in-depth filter). GitLab: `event` is null. |
| 7 | `resolveBranchSha` | `(args: { branch: string, repo?: string }) → AdapterResult<{ sha: string } \| null>` | `ci_wait_run` (1 handler, GitHub-only in practice) | GitLab returns `platform_unsupported: true`. |
| 8 | `fetchBranchSha` | `(args: { branch: string, repo?: string }) → AdapterResult<{ sha: string }>` | `wave_init` (1 handler) | Non-null variant of `resolveBranchSha` — throws on missing branch. **Open question for Phase 2:** collapse #7 and #8 into one sub-call with a nullable return + typed not-found code? Recommendation: yes — one sub-call, `resolveBranchSha` returns `null` on missing branch, caller decides whether to throw. |
| 9 | `createBranch` | `(args: { branch: string, sha: string, repo?: string }) → AdapterResult<void>` | `wave_init` (1 handler) | |
| 10 | `fetchCiTrustSignal` | `(args: { repo?: string }) → AdapterResult<{ level: 'pre_merge_authoritative'\|'post_merge_required'\|'unknown', reason: string }>` | `wave_ci_trust_level` (1 handler) | See §3.4 — chose coarse-grained over exposing fine-grained `fetchRulesetList`/`fetchRuleset`/`fetchBranchProtection`/`fetchRepoMeta`. Revisit if a second consumer appears. |

### 4.1 Already-shipped hybrid sub-call (reference, not part of proposal)

- `fetchPrState` — shipped in Story 1.11 / PR #278. Consumed by `pr_merge_wait` and `pr_merge`. Pattern reference for every sub-call above.

### 4.2 Full-migration methods (direct interface additions, not sub-calls)

| # | Method | Handlers migrated |
|---|--------|-------------------|
| 1 | `ciFailedJobs` | `ci_failed_jobs` |
| 2 | `ciRunLogs` | `ci_run_logs` |
| 3 | `ciRunStatus` | `ci_run_status` |
| 4 | `ciRunsForBranch` | `ci_runs_for_branch` |
| 5 | `labelCreate` | `label_create` |
| 6 | `labelList` | `label_list` |
| 7 | `workItem` | `work_item` |

**Total Phase 2 surface expansion:** 7 full-migration methods + 10 hybrid sub-calls = **17 new `PlatformAdapter` methods** (on top of the 10 already migrated → 27 at Phase 2 close). Matches the rough magnitude the Dev Spec anticipated (§5.1 "others TBD per survey output").

---

## 5. Phase 2 wave-grouping recommendation

**Recommendation: 6 waves (pa-6 through pa-11).** Groupings maximize file-overlap independence for parallel flights and honor the `fetchIssue`-first dependency.

### 5.1 Wave map

```
PHASE 2 — 22 remaining migrations
──────────────────────────────────
Wave 2.1 (pa-6) ─── Story 2.1: Land fetchIssue adapter + types refinement
                          │      (single story, no parallelism; blocks Wave 2.2)
                          ▼
Wave 2.2 (pa-7) ─┬─ Story 2.2: Migrate spec_get
                  ├─ Story 2.3: Migrate spec_validate_structure       (5 parallel —
                  ├─ Story 2.4: Migrate spec_acceptance_criteria       fetchIssue consumers,
                  ├─ Story 2.5: Migrate spec_dependencies              disjoint handler files)
                  └─ Story 2.6: Migrate epic_sub_issues
                          │
Wave 2.3 (pa-8) ─┬─ Story 2.7: Migrate dod_load_manifest
                  ├─ Story 2.8: Migrate wave_compute                  (4 parallel —
                  ├─ Story 2.9: Migrate wave_dependency_graph         fetchIssue consumers
                  └─ Story 2.10: Migrate wave_topology                 round 2)
                          │
Wave 2.4 (pa-9) ─┬─ Story 2.11: Migrate ci_failed_jobs                (4 parallel — CI family
                  ├─ Story 2.12: Migrate ci_run_logs                   full-migrations,
                  ├─ Story 2.13: Migrate ci_run_status                 disjoint handlers;
                  └─ Story 2.14: Migrate ci_runs_for_branch            no shared sub-calls)
                          │
Wave 2.5 (pa-10) ┬─ Story 2.15: Migrate label_create                  (3 parallel — remaining
                  ├─ Story 2.16: Migrate label_list                    full-migrations)
                  └─ Story 2.17: Migrate work_item
                          │
Wave 2.6 (pa-11) ┬─ Story 2.18: Migrate ibm (adds fetchPrForBranch)   (6 serial or
                  ├─ Story 2.19: Migrate ci_wait_run (adds             2-at-a-time; each adds
                  │               ciListRuns + resolveBranchSha)       its own sub-call(s))
                  ├─ Story 2.20: Migrate wave_previous_merged
                  │               (adds fetchIssueClosure)
                  ├─ Story 2.21: Migrate wave_reconcile_mrs
                  │               (adds findMergedPrForBranchPrefix)
                  ├─ Story 2.22: Migrate wave_init (adds
                  │               resolveBranchSha [reused] + createBranch)
                  ├─ Story 2.23: Migrate wave_finalize (adds
                  │               findExistingPr, reuses prCreate)
                  └─ Story 2.24: Migrate wave_ci_trust_level
                                  (adds fetchCiTrustSignal)
```

### 5.2 Rationale

- **Wave 2.1 is single-story by construction.** `fetchIssue` is the keystone sub-call (10 downstream handlers). Landing it alone lets every subsequent wave treat it as already-present. Follows the same pattern as Story 1.2 (single foundational story before the canary cluster).
- **Waves 2.2 + 2.3 split the 10 `fetchIssue` consumers into two adjacent waves.** Not for dependency reasons (they're all parallel) but to keep each wave's flight count ≤5 (flight-partition comfort ceiling). Ordered alphabetically within each wave; no file conflicts because each handler migration touches disjoint files (`handlers/<h>.ts`, new `lib/adapters/<h>-{github,gitlab}.ts`, `scripts/ci/migration-allowlist.txt` — the allowlist edit is the one shared file; commutativity-verifier handles it via the same single-line-remove pattern Phase 1 used).
- **Waves 2.4 + 2.5 are the full-migration cluster.** No new sub-calls added; each handler is a direct adapter method. Max parallelism.
- **Wave 2.6 is the sub-call-heavy cluster.** Six stories, each introducing one or more new sub-calls. Recommend running **serial** (or at most 2-parallel) because the sub-calls collide in `types.ts` additions; the scaffold/dispatch pattern is per-story stable but `MIGRATED_METHODS` set and `PLATFORM_ADAPTER_METHODS` list will see rapid churn. Each story's AC should include a contract-test-update step that keeps `MIGRATED_METHODS` honest.

### 5.3 Sub-call landing order (within Wave 2.6)

Recommend this order for Wave 2.6 (narrow-first):

1. `fetchIssueClosure` — single-consumer, narrow sub-call; good warm-up.
2. `resolveBranchSha` — shared between `ci_wait_run` (hybrid with `ciListRuns`) and `wave_init`. Landing it first makes `wave_init` (Story 2.22) a near-mechanical migration.
3. `fetchPrForBranch`, `findMergedPrForBranchPrefix` — narrow, independent.
4. `createBranch` — narrow; sibling to `resolveBranchSha`.
5. `ciListRuns` — the ci_wait_run consumer lands after its sibling sub-call.
6. `findExistingPr` — composes with the already-shipped `prCreate`.
7. `fetchCiTrustSignal` — last, coarse-grained, single-consumer.

### 5.4 File-overlap notes

All Wave 2.1-2.5 flights touch disjoint handler files — the commutativity-verifier returns STRONG for every cross-pair within a wave. The only shared file across any two flights in a given wave is `scripts/ci/migration-allowlist.txt`. Phase 1 proved (Waves 1.3, 1.4) that single-line removals from the allowlist commute cleanly under wave-pattern merge ordering.

Wave 2.6 has two sub-call-pair overlaps worth noting:

- `ci_wait_run` (Story 2.19) + `wave_init` (Story 2.22) both land `resolveBranchSha`. Whichever ships second gets a simpler diff (reuse). Land `ci_wait_run` first per §5.3, and `wave_init` becomes reuse-only.
- `wave_finalize` (Story 2.23) adds `findExistingPr` but the existing `prCreate` stays unchanged. No collision with canary.

### 5.5 Out-of-band work identified during survey

Follow-ups to consider filing as separate issues (BJ-endorsed "follow-up chain > scope creep" pattern):

1. **`work_item` type-vs-platform bug.** `createGithubPR` runs on GitLab when `type: 'pr'`; `createGitlabMR` runs on GitHub when `type: 'mr'`. Either collapse type to `{issue, pr_or_mr}` (two values) or teach the handler to return `platform_unsupported` when `type: 'pr'` on GitLab / `type: 'mr'` on GitHub. Close during Story 2.17 — but file a bug first so the migration AC has a regression test to reference.
2. **`wave_reconcile_mrs` 50-item client-side scan.** Known limitation; worth documenting in `docs/adapters/README.md` §"where to add a method" as an example of "no server-side filter? fall back to generous limit + client filter".
3. **`dod_load_manifest` cross-repo refs on GitLab.** The `ISSUE_REF` branch is GitHub-only today (`m1` only fires on `platform === 'github'`). Worth closing the gap to match the spec_* handlers' cross-repo support during Story 2.7 — OR filing as a pre-existing bug and letting the migration inherit the fix.

---

## 6. Notes for `/devspec` re-run

Anything the spec author needs to write a binding Section 8 Phase 2 plan:

1. **Total story count:** 24 stories (one keystone + 22 handler migrations + one follow-up-cleanup closer if the §5.5 bugs get bundled). Dev Spec Wave Map today says "TBD pending Phase 1 survey output" — replace with the 6-wave layout in §5.1.
2. **`PlatformAdapter` interface expansion:** 17 new methods per §4. Update `lib/adapters/types.ts` scaffolding in Story 2.1 (land `fetchIssue`) and extend the interface in-place via each story's `types.ts` edit.
3. **`MIGRATED_METHODS` and `PLATFORM_ADAPTER_METHODS` churn:** every Wave 2.6 story edits both. Keep the compile-time `_methodsExhaustive` check honest by adding method names to `PLATFORM_ADAPTER_METHODS` in the same PR that adds the interface method — same rhythm as Phase 1.
4. **Wave IDs:** recommend `wave-pa-6` through `wave-pa-11` (continuing the pa-N scheme from Phase 1). Avoid `phase2-*` prefixes to keep wave filtering grep-friendly.
5. **DoD for Phase 2:** handler ≤80 lines, zero `if (platform === 'github')` / zero direct subprocess in `handlers/`, contract test passes, full suite ≥1659 passes, migration-allowlist.txt reduced by one per story. Copy the per-story AC block from Story 1.3 and parameterize.
6. **Carry-over decisions:**
   - `resolveBranchSha` vs `fetchBranchSha` — recommend merged into one, nullable return (§4, row 8).
   - `fetchPrForBranch` vs `findMergedPrForBranchPrefix` — recommend keep separate (§3.4 `wave_reconcile_mrs` note).
   - `fetchCiTrustSignal` coarse-grained vs four fine-grained — recommend coarse-grained (§3.4 `wave_ci_trust_level` note).
7. **Phase 3 prerequisites still unchanged:** `lib/glab.ts` deletion must wait until all remaining importers (mostly the hybrid handlers that use `gitlabApiIssue`) have migrated. By end of Wave 2.6, all `gitlabApi*` importers should be gone from `handlers/`. Confirm with a grep in Story 2.24's AC.
8. **Contract-test amendment:** after `fetchIssueClosure` lands (Story 2.20), it WON'T be in `MIGRATED_METHODS` for long — every Wave 2.6 story appends one. Consider loosening the test's hard-coded method list to a dynamically-computed "implementations that don't return `platform_unsupported`" probe, avoiding the one-line churn per story. Tracked as a separate micro-improvement, not a blocker.

---

## 7. Acceptance criteria walk (Story 1.12)

- [x] **`docs/adapters/survey.md` exists** — this file.
- [x] **All 22 handlers classified** — 23 surveyed (one-off reconciled in §1.1); each has a dedicated subsection under §3.
- [x] **Sub-call aggregation complete** — §4 deduplicates 10 sub-calls across all hybrid handlers with typed signatures and consumer lists.
- [x] **Phase 2 wave count + grouping recommendation present** — §5 recommends 6 waves with handler-by-name groupings and rationale.
- [x] **Output is sufficient input for re-running `/devspec`** — §6 enumerates the decisions the spec author needs to make; §5.1 provides the wave-map skeleton ready to drop into Section 8.
