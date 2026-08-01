# MCP Tools

Tool reference for the `sdlc-server` MCP. The authoritative list is the registered handlers in `handlers/_registry.ts` (auto-generated from `handlers/*.ts` on build/test/validate). This document records prose summaries; for complete schemas use `ListTools` against the running server.

Tools below are listed in alphabetic order. To add a tool: drop a file in `handlers/<name>.ts`; the next CI run regenerates the registry and exposes it.

## pr_wait_ci

**Purpose.** Block until a PR/MR's status checks settle. Server-side polling with configurable interval (default `30s`, hard floor `5s`) and timeout (default `1800s`). Used by `/scpmmr`, the wave-pattern Flight finalizer, and any caller that needs a deterministic "wait for CI to finish" with a typed terminal.

**Inputs.**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `number` | number | (required) | PR (GitHub) or MR (GitLab) iid. |
| `poll_interval_sec` | number | `30` | Seconds between snapshots. Hard floor `5`. |
| `timeout_sec` | number | `1800` | Maximum wall-clock wait. |
| `repo` | string | (cwd remote) | `owner/repo` slug for cross-repo dispatch. GitLab nested groups (`group/subgroup/repo`) are accepted. |

**Returns — polling-loop path** (one or more checks configured on the head ref).

```json
{
  "ok": true,
  "number": 42,
  "final_state": "passed" | "failed" | "timed_out",
  "checks": { "total": 3, "passed": 3, "failed": 0, "pending": 0, "summary": "3/3 passed" },
  "waited_sec": 8,
  "url": "https://github.com/org/repo/pull/42"
}
```

`final_state: 'passed'` requires `total > 0 && pending === 0 && failed === 0`. All-skipped checks (every workflow's `if:` guard didn't match) count as `passed` — see #221.

**Returns — no checks** (#416, reworked by #508). When the head ref still has no
registered checks after a **settle window**, the handler returns without entering
the polling loop.

#416 returned here at t=0 on the first empty rollup. An empty rollup is also
exactly what a merely-**queued** check looks like, so a PR whose CI had not
started yet got a definite, successful-sounding verdict with `elapsed_sec: 0`.
So the handler now keeps probing for `settle_window_sec` (default 45s), and if
nothing has registered by then it cross-checks the **head SHA** for CI runs
before deciding which of two facts is true:

| status | meaning | `mergeable` |
|---|---|---|
| `no_checks_configured` | the ref-query succeeded and found no runs — this repo genuinely runs no checks here | may be `true` |
| `no_checks_yet` | runs exist for the head SHA that have not registered as checks, **or** the ref-query could not be run at all | always `false` |

**Only a query that SUCCEEDED and found nothing may report `no_checks_configured`.**
A failed query, or a missing head SHA, yields `no_checks_yet` with
`blocker: "evidence_unavailable"` — an instrument that examined nothing must
never return the answer a caller might merge on.

```json
{
  "ok": true,
  "number": 42,
  "status": "no_checks_yet",
  "elapsed_sec": 45,
  "settled_sec": 45,
  "mergeable": false,
  "blocker": "checks_not_registered",
  "pending_runs": [{ "run_id": 991, "workflow_name": "validate", "status": "queued" }],
  "url": "https://github.com/org/repo/pull/42"
}
```

When there are no checks AND the PR/MR is obstructed (draft, closed, conflicts, …),
the settle window is skipped entirely — a closed PR is not going to start CI — and
`settled_sec` is `0`:

```json
{
  "ok": true,
  "number": 42,
  "status": "no_checks_configured",
  "elapsed_sec": 0,
  "settled_sec": 0,
  "mergeable": false,
  "blocker": "draft" | "closed" | "merged" | "conflicts" | "not_mergeable" | "locked",
  "url": "https://github.com/org/repo/pull/42"
}
```

> **`no_checks_required` is gone.** It meant both facts above, and its
> plain-English name reads as "nothing is wrong". It is removed rather than
> aliased so that callers matching the old literal stop matching — a deliberate
> forcing function. Callers that allowlist on `final_state === 'passed'` are
> unaffected.

**Discriminator.** Callers should branch on the response shape via either field:

- `status` present (`no_checks_configured` | `no_checks_yet`) → no-checks return (`final_state` absent). **Neither value is a pass.**
- `final_state` present → polling-loop result (`status` absent).

**Platform notes.**

- GitHub: probe is `gh pr view <num> --json statusCheckRollup,url,state,isDraft,mergeable,mergeStateStatus,headRefOid` (`headRefOid` anchors the #508 ref cross-check). Polling-loop snapshot uses the slimmer `--json statusCheckRollup,url` (per-iteration cost stays minimal). `gh pr checks --json` is NOT used — it broke on Ubuntu 24.04's gh 2.45 (#220).
- GitLab: probe is `glab api projects/<encoded-slug>/merge_requests/<iid>`. Empty-rollup means `head_pipeline === null && pipeline === null` — which on GitLab is also what "the pipeline has not been created yet" looks like, since pipelines are created asynchronously after the MR (#508). Polling-loop status mapping: `success → passed`, `failed/canceled → failed`, `running/pending/created/preparing/waiting_for_resource/scheduled/manual → pending`, anything else → uncounted (loop times out).

**See also.** `pattern_decorative_ac_and_stub_orphan.md` for the failure mode this short-circuit closes (autopilot callers losing 30-minute timeout windows on docs-only PRs with no CI).

## wave_wait_for_signal

**Purpose.** Sanctioned idle-wait for wave-pattern Orchestrators (and Primes) that have dispatched work and need to block until filesystem-bus artifacts appear. Replaces ad-hoc polling loops, `Bash(sleep)` invocations, and the agent-anxiety failure mode where idle loops are exited prematurely with non-canonical lines like `"Sleep is still running. Let me wait for the notification."` See `pattern_sanctioned_fidget_tool.md` (cc-workflow memory) for the design rationale.

**Inputs.**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `signal_path` | string | (required) | Absolute path or glob pattern (Bun.Glob syntax). Examples: `/wavebus/wave-4a/flights/*.done`, `wavebus/<wave_id>/flight-1.done`. |
| `timeout_sec` | number | `1800` | Maximum wall-clock wait, in seconds. |
| `min_count` | number | `1` | Minimum match count required to satisfy the signal. |

**Behavior.** Polls every 5 seconds. Returns immediately if `min_count` matches already exist (no opening sleep). Glob patterns and literal paths are both accepted; relative patterns scan from `CLAUDE_PROJECT_DIR` (or `cwd()`). Matches are sorted alphabetically.

**Returns (success).**

```json
{ "ok": true, "matched": ["...absolute paths..."], "elapsed_sec": 7 }
```

**Returns (timeout).**

```json
{ "ok": true, "timed_out": true, "elapsed_sec": 1800, "partial_matches": ["...subset paths..."] }
```

`partial_matches` is the snapshot from the final poll before timeout — empty array if no matches ever appeared.

**See also.** `docs/wave-pattern-orchestration.md` for the canonical Orchestrator-wait-on-Flights example.
