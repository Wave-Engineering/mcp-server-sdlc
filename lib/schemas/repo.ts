/**
 * Shared `repo` parameter schema for MCP tool input validation.
 *
 * Single source of truth for the regex pattern that validates the repository
 * slug across every handler that takes a `repo: <owner>/<name>` argument
 * (`pr_*`, `ci_*`, `wave_*`, `label_*`, `work_item`, …).
 *
 * Pattern: `^[a-zA-Z0-9._-]+(/[a-zA-Z0-9._-]+)+$` — accepts arbitrary `/`
 * depth so GitLab nested groups (e.g.
 * `analogicdev/internal/tools/blueshift/blueshift-docmancer-ui`) validate
 * the same way as flat GitHub `owner/repo` slugs (#290).
 *
 * Each segment must be ≥ 1 char from the set `[a-zA-Z0-9._-]` — empty
 * segments (`a//b`), leading/trailing slashes, and bare `owner` (no `/`)
 * are still rejected.
 */
import { z } from 'zod';

/**
 * Regex that validates `owner/name` AND nested-group `org/sub/.../name` slugs.
 * Exported separately so non-Zod call-sites (raw validation, formatting hints)
 * can share the same pattern.
 */
export const REPO_SLUG_REGEX = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)+$/;

/**
 * Human-readable error message paired with the regex. Kept identical across
 * every handler so callers see a consistent error string regardless of which
 * MCP tool flagged the failure.
 */
export const REPO_SLUG_ERROR =
  'repo must be in owner/repo or group/subgroup/.../repo format';

/**
 * Optional `repo` Zod schema — handlers that accept `repo` as an optional
 * argument should `.optional()` chain off this base schema (or use the
 * pre-chained `repoOptionalSchema` below).
 */
export const repoSchema = z.string().regex(REPO_SLUG_REGEX, REPO_SLUG_ERROR);

/**
 * Convenience export for the common `repo: optional` shape used by every
 * `pr_*`/`ci_*`/`wave_*` handler.
 */
export const repoOptionalSchema = repoSchema.optional();
