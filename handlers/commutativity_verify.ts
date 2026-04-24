import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { log } from '../logger.js';

const changesetSchema = z.object({
  id: z.string().min(1),
  head_ref: z.string().min(1),
});

const inputSchema = z.object({
  repo_path: z.string().min(1),
  base_ref: z.string().min(1),
  // min 1 relaxes the historical pairwise-only constraint. A single-element
  // array invokes the probe in "single-target safety gate" mode (composed
  // diff vs base_ref) per claudecode-workflow:docs/kahuna-devspec.md §5.1.2.
  changesets: z.array(changesetSchema).min(1, 'At least 1 changeset required'),
  timeout_sec: z.number().int().positive().optional(),
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

const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000;

type Mode = 'pairwise' | 'single_target';

interface SingleTargetResult {
  verdict: string;
  changeset_id: string;
  head_ref: string;
}

const commutativityVerifyHandler: HandlerDef = {
  name: 'commutativity_verify',
  description:
    'Verify changeset commutativity / single-target safety from actual git diffs. ' +
    'Pairwise mode (≥2 changesets): decides whether the merge train pipeline is needed for a flight of MRs — call AFTER all MR pipelines in the flight pass (pr_wait_ci green) and BEFORE pr_merge. ' +
    'Single-target mode (1 changeset): KAHUNA composed-diff safety gate — is this branch safe to land in base_ref? ' +
    'The response includes both mode-specific fields and legacy aliases (`group_verdict`, `pairs`) for backward compat.',
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

    const mode: Mode = args.changesets.length === 1 ? 'single_target' : 'pairwise';
    // timeout_sec (input, seconds) → milliseconds for execSync's `timeout` option.
    const timeoutMs = args.timeout_sec !== undefined
      ? args.timeout_sec * 1000
      : DEFAULT_SUBPROCESS_TIMEOUT_MS;

    // Build ref→id mapping so we return caller-provided IDs, not raw branch refs.
    const refToId = new Map<string, string>();
    for (const cs of args.changesets) {
      refToId.set(cs.head_ref, cs.id);
    }

    const cmd = buildCommand(args);
    let raw: string;
    const subStart = Date.now();
    try {
      raw = execSync(cmd, {
        encoding: 'utf8',
        timeout: timeoutMs,
        cwd: args.repo_path,
      });
      log.info('subprocess', { cmd: 'commutativity-probe', exit_code: 0, ms: Date.now() - subStart });
    } catch (err) {
      const subMs = Date.now() - subStart;
      // Fail safe: any subprocess error → ORACLE_REQUIRED verdict with warning.
      const message = err instanceof Error ? err.message : String(err);
      // Real execSync timeouts set err.code === 'ETIMEDOUT'. Fall back to
      // substring match for mocked errors and older runtimes.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const timedOut = code === 'ETIMEDOUT'
        || message.includes('ETIMEDOUT')
        || message.includes('timed out');
      if (timedOut) {
        log.warn('subprocess', { cmd: 'commutativity-probe', exit_code: -1, ms: subMs }, 'Subprocess timed out');
        const timeoutBody: Record<string, unknown> = {
          ok: true,
          mode,
          verdict: 'ORACLE_REQUIRED',
          group_verdict: 'ORACLE_REQUIRED',
          pairs: [],
          warnings: [`Subprocess timed out after ${timeoutMs}ms. Failing safe to ORACLE_REQUIRED.`],
        };
        if (mode === 'pairwise') {
          timeoutBody.pairwise_results = [];
        } else {
          const cs = args.changesets[0];
          timeoutBody.single_target_result = {
            verdict: 'ORACLE_REQUIRED',
            changeset_id: cs.id,
            head_ref: cs.head_ref,
          } satisfies SingleTargetResult;
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(timeoutBody) }],
        };
      }
      log.error('subprocess', { cmd: 'commutativity-probe', exit_code: -1, ms: subMs, stderr: message.slice(0, 200) });
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
    const verdict = isValidVerdict(probe.flight_verdict)
      ? probe.flight_verdict
      : 'ORACLE_REQUIRED';

    const warnings: string[] = [];
    if (!isValidVerdict(probe.flight_verdict)) {
      warnings.push(`Unknown verdict '${probe.flight_verdict}' from probe — defaulting to ORACLE_REQUIRED`);
    }

    // Validate per-pair verdicts. Expected empty in single-target mode — if
    // a future probe version deviates, drop the pairs and emit a warning
    // rather than producing a contradictory response with both
    // single_target_result and pairwise_results populated.
    let pairs = mapPairIds(probe.pairs, refToId).map(p => ({
      ...p,
      verdict: isValidVerdict(p.verdict) ? p.verdict : 'ORACLE_REQUIRED',
    }));
    if (mode === 'single_target' && pairs.length > 0) {
      warnings.push(`Probe returned ${pairs.length} pair(s) for a single-target call — discarding (unexpected shape)`);
      pairs = [];
    }

    const body: Record<string, unknown> = {
      ok: true,
      mode,
      verdict,
      // Backward-compat alias — nextwave skill and other pre-§5.1.2 consumers
      // read `group_verdict`. Remove when all consumers migrate to `verdict`.
      group_verdict: verdict,
      pairs,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
    if (mode === 'pairwise') {
      body.pairwise_results = pairs;
    } else {
      const cs = args.changesets[0];
      body.single_target_result = {
        verdict,
        changeset_id: cs.id,
        head_ref: cs.head_ref,
      } satisfies SingleTargetResult;
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    };
  },
};

export default commutativityVerifyHandler;
