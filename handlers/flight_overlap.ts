import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { computePairConflicts, conflictFreeGroups } from '../lib/flight_overlap';

const manifestSchema = z.object({
  issue_ref: z.string().min(1),
  files_to_create: z.array(z.string()).optional(),
  files_to_modify: z.array(z.string()).optional(),
});

const inputSchema = z.object({
  manifests: z.array(manifestSchema),
});

const flightOverlapHandler: HandlerDef = {
  name: 'flight_overlap',
  description:
    'Compute file-overlap conflicts between issue target manifests. Each conflict includes an overlap_type (manifest_only | source | mixed) so callers can discount DEPENDENCY_MANIFEST-only overlaps.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const conflicts = computePairConflicts(args.manifests);
      const groups = conflictFreeGroups(args.manifests, conflicts);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              conflicts,
              conflict_free_groups: groups,
              manifest_count: args.manifests.length,
              conflict_count: conflicts.length,
            }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default flightOverlapHandler;
