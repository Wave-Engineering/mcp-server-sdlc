## Summary

Add a JSON schema validator for pipeline configuration files, catching malformed configs at load time.

## Context

Today malformed configs silently produce runtime failures downstream. A schema gate at load time gives actionable errors.

## Implementation Steps

1. Add `schema/pipeline_config.schema.json` following JSON Schema draft-07.
2. Implement `validatePipelineConfig(cfg)` in `src/config/validate.ts`.
3. Call `validatePipelineConfig` from `PipelineConfigLoader.load()`.

## Test Procedures

### Unit Tests

| Test Name | Purpose | File Location |
|-----------|---------|---------------|
| `test_valid_config_accepted` | Known-good config passes validation | `tests/config/validate.test.ts` |
| `test_invalid_enum_rejected` | Invalid archetype enum fails with path + reason | `tests/config/validate.test.ts` |
| `test_missing_required_field_rejected` | Missing required field fails with path | `tests/config/validate.test.ts` |

### Integration/E2E Coverage

- IT-03 — now runnable (loader boundary enforces schema gate).

## Acceptance Criteria

- [ ] `schema/pipeline_config.schema.json` exists and is valid JSON Schema.
- [ ] `validatePipelineConfig` rejects invalid configs with path + reason.
- [ ] `PipelineConfigLoader.load()` fails cleanly on schema violations.
- [ ] All tests in `tests/config/validate.test.ts` pass.

## Dependencies

- #86
- Wave-Engineering/mcp-server-sdlc#181
