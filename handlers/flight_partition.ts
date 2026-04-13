import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import {
  classifyFile,
  computePairConflicts,
  conflictFreeGroups,
  type Manifest,
} from '../lib/flight_overlap';

const manifestSchema = z.object({
  issue_ref: z.string().min(1),
  files_to_create: z.array(z.string()).optional(),
  files_to_modify: z.array(z.string()).optional(),
});

const predictedVerdictSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  verdict: z.enum(['STRONG', 'MEDIUM', 'WEAK', 'ORACLE_REQUIRED']),
});

const inputSchema = z.object({
  manifests: z.array(manifestSchema),
  strategy: z.enum(['safe', 'aggressive']).optional().default('safe'),
  /** Optional file-to-FileClass mapping. When provided, overrides the
   *  built-in `classifyFile()` for the specified paths. Useful when the
   *  caller already has classification data from commutativity-probe. */
  file_classifications: z.record(z.string(), z.string()).optional(),
  /** Optional predicted verdicts from commutativity_predict. When present,
   *  pairs with STRONG/MEDIUM verdicts are allowed in the same flight even
   *  if they have file-level conflicts. */
  predicted_verdicts: z.array(predictedVerdictSchema).optional(),
});

interface Flight {
  number: number;
  issues: string[];
  reason: string;
}

const flightPartitionHandler: HandlerDef = {
  name: 'flight_partition',
  description:
    'Partition issues into conflict-free flights. Overlaps on DEPENDENCY_MANIFEST files (Cargo.toml, package.json, go.mod, etc.) are discounted — issues that only share manifest/lockfile paths stay in the same flight. commutativity_verify at merge time remains the safety net.',
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
      const manifests: Manifest[] = args.manifests;
      if (manifests.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                flights: [],
                strategy_used: args.strategy,
                conflict_count: 0,
              }),
            },
          ],
        };
      }

      const conflicts = computePairConflicts(manifests);
      const groups = conflictFreeGroups(manifests, conflicts, args.predicted_verdicts);

      const flights: Flight[] = groups.map((issues, idx) => {
        let reason: string;
        if (issues.length === manifests.length) {
          reason = 'all issues are conflict-free; single parallel flight';
        } else if (issues.length === 1) {
          reason = `isolated due to file conflicts with other issues`;
        } else {
          reason = `${issues.length} issues grouped as conflict-free subset (${args.strategy} strategy)`;
        }
        return {
          number: idx + 1,
          issues,
          reason,
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              flights,
              strategy_used: args.strategy,
              conflict_count: conflicts.length,
              total_issues: manifests.length,
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

export default flightPartitionHandler;
