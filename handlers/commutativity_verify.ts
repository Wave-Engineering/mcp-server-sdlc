import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const changesetSchema = z.object({
  id: z.string().min(1),
  head_ref: z.string().min(1),
});

const inputSchema = z.object({
  repo_path: z.string().min(1),
  base_ref: z.string().min(1),
  changesets: z.array(changesetSchema).min(2, 'At least 2 changesets required for pairwise analysis'),
});

type Input = z.infer<typeof inputSchema>;

interface ProbePair {
  a: string;
  b: string;
  verdict: string;
  reason: string;
  file_overlaps: string[];
  symbol_collisions: string[];
  import_overlaps: string[];
}

interface ProbeOutput {
  changesets: string[];
  flight_verdict: string;
  pairs: ProbePair[];
}

const VALID_VERDICTS = ['STRONG', 'MEDIUM', 'WEAK', 'ORACLE_REQUIRED'] as const;

function isValidVerdict(v: string): v is (typeof VALID_VERDICTS)[number] {
  return (VALID_VERDICTS as readonly string[]).includes(v);
}

/**
 * Shell-escape a value for safe inclusion in a single-quoted shell argument.
 * Prevents injection when user-provided values (repo paths, refs) contain
 * spaces, quotes, or metacharacters.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build the commutativity-probe CLI command with shell-escaped arguments. */
function buildCommand(args: Input): string {
  const branches = args.changesets.map(c => shellEscape(c.head_ref));
  return [
    'commutativity-probe',
    'analyze',
    '--repo', shellEscape(args.repo_path),
    '--base', shellEscape(args.base_ref),
    '--json',
    ...branches,
  ].join(' ');
}

/** Map probe changeset IDs (branch refs) back to caller-provided IDs. */
function mapPairIds(
  pairs: ProbePair[],
  refToId: Map<string, string>,
): ProbePair[] {
  return pairs.map(p => ({
    ...p,
    a: refToId.get(p.a) ?? p.a,
    b: refToId.get(p.b) ?? p.b,
  }));
}

const SUBPROCESS_TIMEOUT_MS = 30_000;

const commutativityVerifyHandler: HandlerDef = {
  name: 'commutativity_verify',
  description:
    'Verify changeset commutativity from actual git diffs. Determines whether the merge train pipeline is needed for a flight of MRs. ' +
    'Call AFTER all MR pipelines in a flight pass (pr_wait_ci green) and BEFORE pr_merge. ' +
    'Requires at least 2 changesets — skip for single-MR flights.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    // Build ref→id mapping so we return caller-provided IDs, not raw branch refs.
    const refToId = new Map<string, string>();
    for (const cs of args.changesets) {
      refToId.set(cs.head_ref, cs.id);
    }

    const cmd = buildCommand(args);
    let raw: string;
    try {
      raw = execSync(cmd, {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
        cwd: args.repo_path,
      });
    } catch (err) {
      // Fail safe: any subprocess error → ORACLE_REQUIRED verdict with warning.
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = message.includes('ETIMEDOUT') || message.includes('timed out');
      if (timedOut) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              group_verdict: 'ORACLE_REQUIRED',
              pairs: [],
              warnings: [`Subprocess timed out after ${SUBPROCESS_TIMEOUT_MS}ms. Failing safe to ORACLE_REQUIRED.`],
            }),
          }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `commutativity-probe failed: ${message}` }) }],
      };
    }

    let probe: ProbeOutput;
    try {
      probe = JSON.parse(raw) as ProbeOutput;
    } catch {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: `Failed to parse commutativity-probe JSON output` }),
        }],
      };
    }

    // Validate the verdict value from the probe.
    const groupVerdict = isValidVerdict(probe.flight_verdict)
      ? probe.flight_verdict
      : 'ORACLE_REQUIRED';

    const warnings: string[] = [];
    if (!isValidVerdict(probe.flight_verdict)) {
      warnings.push(`Unknown verdict '${probe.flight_verdict}' from probe — defaulting to ORACLE_REQUIRED`);
    }

    // Validate per-pair verdicts.
    const pairs = mapPairIds(probe.pairs, refToId).map(p => ({
      ...p,
      verdict: isValidVerdict(p.verdict) ? p.verdict : 'ORACLE_REQUIRED',
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          group_verdict: groupVerdict,
          pairs,
          warnings: warnings.length > 0 ? warnings : undefined,
        }),
      }],
    };
  },
};

export default commutativityVerifyHandler;
