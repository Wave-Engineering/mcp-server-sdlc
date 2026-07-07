// Bun test preload (configured in bunfig.toml [test].preload).
//
// Disable FlightDeck emit by default for the whole test suite so handlers now
// wired with emit() (S1.5) never touch the real durable buffer
// (~/.claude/status/events.jsonl) or POST to an ingest endpoint during
// unrelated handler tests. The two FlightDeck test files opt back in per-test
// by deleting this var and setting FLIGHTDECK_EVENTS_PATH to a temp file.
//
// Only set the default when the environment hasn't already made a choice, so a
// developer/CI that deliberately exercises emit can override it.
if (process.env.FLIGHTDECK_EMIT_DISABLED === undefined) {
  process.env.FLIGHTDECK_EMIT_DISABLED = '1';
}
