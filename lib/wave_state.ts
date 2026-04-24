/**
 * Canonical wave-state schema.
 *
 * Wave state lives at `.claude/status/state.json` and is written by the Python
 * `wave_status` CLI in the claudecode-workflow repo; sdlc-server handlers
 * read it. The schema here is the authoritative contract shared between the
 * two processes.
 *
 * Backward compat: all new fields (`kahuna_branch`, `kahuna_branches`, and
 * the `gate_evaluating`/`gate_blocked` action values) are additive. Legacy
 * state files that pre-date KAHUNA parse cleanly against this schema — the
 * optional fields are simply absent.
 *
 * See claudecode-workflow:docs/kahuna-devspec.md §5.1.4 for the authoritative
 * field definitions.
 */

import { z } from 'zod';

/**
 * Enumeration of action values known to this schema version. Callers who
 * want strict validation of an action value can call
 * `WaveStateActionSchema.parse(value)` directly.
 *
 * **Not enforced at parse time by `CurrentActionSchema`.** The Python
 * `wave_status` CLI is the authoritative writer and may introduce new action
 * values ahead of a coordinated schema bump. To keep state-file reads
 * forward-compatible, `CurrentActionSchema.action` is typed as `z.string()`.
 * This enum exists as documentation + an opt-in validator, not a gate.
 */
export const WaveStateActionSchema = z.enum([
  'idle',
  'planning',
  'preflight',
  'in-flight',
  'flight-done',
  'review',
  'merging',
  'waiting',
  'waiting-ci',
  'complete',
  'gate_evaluating',
  'gate_blocked',
]);

export type WaveStateAction = z.infer<typeof WaveStateActionSchema>;

/**
 * Current-action sub-schema. `action` is deliberately `z.string()` rather
 * than `WaveStateActionSchema` — see the docstring on `WaveStateActionSchema`
 * for the forward-compat rationale.
 */
export const CurrentActionSchema = z
  .object({
    action: z.string(),
    label: z.string().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

export type CurrentAction = z.infer<typeof CurrentActionSchema>;

export const WaveEntrySchema = z
  .object({
    status: z.string().optional(),
    mr_urls: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type WaveEntry = z.infer<typeof WaveEntrySchema>;

export const IssueEntrySchema = z
  .object({
    status: z.string().optional(),
  })
  .passthrough();

export type IssueEntry = z.infer<typeof IssueEntrySchema>;

export const KahunaDispositionSchema = z.enum(['merged', 'aborted']);

export type KahunaDisposition = z.infer<typeof KahunaDispositionSchema>;

/**
 * One historical kahuna branch. `main_merge_sha` is populated when
 * disposition === "merged"; `abort_reason` when disposition === "aborted".
 * Neither field is required at the schema level — callers may populate
 * whichever is relevant and omit the other.
 */
export const KahunaBranchHistoryEntrySchema = z
  .object({
    branch: z.string().min(1),
    epic_id: z.number().int().positive(),
    created_at: z.string().min(1),
    resolved_at: z.string().min(1),
    disposition: KahunaDispositionSchema,
    main_merge_sha: z.string().optional(),
    abort_reason: z.string().optional(),
  })
  .passthrough();

export type KahunaBranchHistoryEntry = z.infer<typeof KahunaBranchHistoryEntrySchema>;

/**
 * Full wave-state shape. All fields are optional at the top level so that
 * partial state files (e.g. freshly initialized, or legacy pre-KAHUNA) parse
 * cleanly. Unknown top-level fields pass through via `.passthrough()` — we
 * never want schema enforcement to drop data written by another process.
 */
export const WaveStateSchema = z
  .object({
    current_wave: z.string().nullable().optional(),
    current_action: CurrentActionSchema.optional(),
    waves: z.record(z.string(), WaveEntrySchema).optional(),
    issues: z.record(z.string(), IssueEntrySchema).optional(),
    deferrals: z.array(z.unknown()).optional(),
    last_updated: z.string().optional(),
    wavemachine_active: z.boolean().optional(),
    // KAHUNA additions (Story 1.4 / issue #207)
    kahuna_branch: z.string().nullable().optional(),
    kahuna_branches: z.array(KahunaBranchHistoryEntrySchema).optional(),
  })
  .passthrough();

export type WaveState = z.infer<typeof WaveStateSchema>;
