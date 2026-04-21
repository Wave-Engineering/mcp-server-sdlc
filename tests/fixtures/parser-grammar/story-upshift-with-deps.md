## Summary

Implement the Pipeline Service responsible for orchestrating stage execution.

## Implementation Steps

1. Create `src/services/pipeline_service.ts` with the `PipelineService` class.
2. Expose `run(config)` → returns a result record.
3. Wire into `src/index.ts`.

## Test Procedures

- Unit: `tests/pipeline_service.test.ts` covering happy path and failure mode.
- Integration: run smoke test against a fixture pipeline config.

## Acceptance Criteria

- [ ] `PipelineService.run()` returns a result record with `status` and `stages`.
- [ ] Unit tests pass.
- [ ] Integration smoke test passes.

## Metadata

- **Wave:** 2
- **Phase:** 1
- **Parent Epic:** #85
- **Dependencies:** Stories 1.1 (#86), 1.2 (#87)
