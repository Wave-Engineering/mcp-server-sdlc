# MCP Tools

Tool reference for the `sdlc-server` MCP. The authoritative list is the registered handlers in `handlers/_registry.ts` (auto-generated from `handlers/*.ts` on build/test/validate). This document records prose summaries; for complete schemas use `ListTools` against the running server.

Tools below are listed in alphabetic order. To add a tool: drop a file in `handlers/<name>.ts`; the next CI run regenerates the registry and exposes it.

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
