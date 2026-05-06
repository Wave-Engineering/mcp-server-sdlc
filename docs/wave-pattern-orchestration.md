# Wave-Pattern Orchestration

How sdlc-server tools support the wave-pattern execution model (Orchestrator + Prime + Flight, filesystem-bus signaling).

## Idle-Waiting on Flight Completion: `wave_wait_for_signal`

When the Orchestrator has dispatched N parallel Flights and must wait for their completion artifacts to appear, it has nothing legitimate to call. Without a sanctioned idle-wait tool, anxious agents invent polling loops, hallucinate completions, or exit prematurely with non-canonical lines like `"Sleep is still running. Let me wait for the notification."` The `wave_wait_for_signal` tool exists so the model has something legitimate to call while it waits.

### Canonical Example: Orchestrator Waiting on Flights

The Orchestrator dispatches three Flight sub-agents, each of which writes `flight-<id>.done` to the wave's filesystem bus when finished:

```
wavebus/
└── wave-4a/
    └── flights/
        ├── flight-1.done   ← written by Flight 1 on completion
        ├── flight-2.done   ← written by Flight 2 on completion
        └── flight-3.done   ← written by Flight 3 on completion
```

After dispatch, the Orchestrator calls:

```jsonc
{
  "tool": "wave_wait_for_signal",
  "args": {
    "signal_path": "wavebus/wave-4a/flights/*.done",
    "timeout_sec": 1800,
    "min_count": 3
  }
}
```

The tool polls every 5 seconds. As soon as all three artifacts exist, it returns:

```json
{
  "ok": true,
  "matched": [
    "/abs/path/wavebus/wave-4a/flights/flight-1.done",
    "/abs/path/wavebus/wave-4a/flights/flight-2.done",
    "/abs/path/wavebus/wave-4a/flights/flight-3.done"
  ],
  "elapsed_sec": 142
}
```

If the timeout expires before all three Flights complete, the response carries `timed_out: true` plus `partial_matches` containing whatever subset did finish. The Orchestrator can then make an informed decision (extend, fail the wave, etc.) instead of guessing.

### Why This Tool Replaces Inline Polling

Without `wave_wait_for_signal`, an Orchestrator wanting the same behavior must either:

1. Call `Bash(sleep ...)` repeatedly with a check between each call — slow, clutters transcripts, and the model frequently exits the loop body early.
2. Use `Bash(while ...)` — large `run:` blocks that violate the project's "no procedural logic in CI/CD YAML" rule when ported and that the model perceives as "I'm not really doing anything" (the anxiety failure mode).
3. Skip waiting entirely and assume Flights are done — produces incorrect verdicts.

`wave_wait_for_signal` collapses all three into one tool call whose entire purpose is to sit still on the agent's behalf. The tool's existence is the mitigation: the model sees a legitimate thing to call and calls it instead of inventing a polling loop or exiting prematurely.

### Configuration Tips

- **`signal_path`.** Use glob patterns (`*.done`, `flight-?.done`) when waiting on N artifacts; use literal paths when waiting on a specific marker file. Relative patterns scan from `CLAUDE_PROJECT_DIR` (or `process.cwd()`). Absolute patterns scan from the filesystem root.
- **`timeout_sec`.** Default 1800 (30 minutes). Should comfortably exceed the longest expected Flight runtime; the Orchestrator can recover from `timed_out` but not from "I gave up too soon."
- **`min_count`.** Set to the number of Flights dispatched. The tool will not return early on a partial set — it sits until either the threshold is met or the timeout fires.

### Related Tools

- `wave_flight_done` — written by Flights to mark completion.
- `wave_flight_plan` — written by Prime(pre-flight) to record the dispatch list the Orchestrator is waiting on.
- `wave_complete` — terminal state transition the Orchestrator drives after `wave_wait_for_signal` returns successfully.
