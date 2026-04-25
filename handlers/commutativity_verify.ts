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

// Wire-side: verdicts the probe is allowed to emit. Validation against
// probe stdout uses this set.
const PROBE_VERDICTS = ['STRONG', 'MEDIUM', 'WEAK', 'ORACLE_REQUIRED'] as const;
// Full union: includes envelope-only verdicts the handler synthesizes
// (timeout → ORACLE_REQUIRED; binary missing → PROBE_UNAVAILABLE). Response
// types and the public schema document this set.
const VERDICTS = [...PROBE_VERDICTS, 'PROBE_UNAVAILABLE'] as const;
type Verdict = (typeof VERDICTS)[number];

function isProbeVerdict(v: string): v is (typeof PROBE_VERDICTS)[number] {
  return (PROBE_VERDICTS as readonly string[]).includes(v);
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

// Build the "fail-safe verdict" envelope shared by the timeout path and the
// probe-missing path. Both synthesize a verdict the probe never emitted, so
// the body shape (mode, alias, mode-appropriate sub-result) must stay
// consistent — divergence here would make callers' dispatch logic brittle.
function buildFailSafeBody(
  args: Input,
  mode: Mode,
  verdict: Verdict,
  warning: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ok: true,
    mode,
    verdict,
    group_verdict: verdict,
    pairs: [],
    warnings: [warning],
  };
  if (mode === 'pairwise') {
    body.pairwise_results = [];
  } else {
    const cs = args.changesets[0];
    body.single_target_result = {
      verdict,
      changeset_id: cs.id,
      head_ref: cs.head_ref,
    } satisfies SingleTargetResult;
  }
  return body;
}

const commutativityVerifyHandler: HandlerDef = {
  name: 'commutativity_verify',
  description:
    'Verify changeset commutativity / single-target safety from actual git diffs. ' +
    'Pairwise mode (≥2 changesets): decides whether the merge train pipeline is needed for a flight of MRs — call AFTER all MR pipelines in the flight pass (pr_wait_ci green) and BEFORE pr_merge. ' +
    'Single-target mode (1 changeset): KAHUNA composed-diff safety gate — is this branch safe to land in base_ref? ' +
    'Verdict union: STRONG | MEDIUM | WEAK | ORACLE_REQUIRED (probe-emitted) | PROBE_UNAVAILABLE (handler-synthesized when the probe binary is missing from PATH; install via scripts/install-remote.sh). ' +
    'PROBE_UNAVAILABLE shares the same body shape as a timeout (mode, verdict, group_verdict alias, pairs:[], warnings:[...], mode-appropriate single_target_result/pairwise_results) and should be treated as conservative-fail (sequential merge fallback) by callers. ' +
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
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const status = (err as { status?: number } | undefined)?.status;

      // Probe binary not on PATH → synthesize PROBE_UNAVAILABLE (#218). With
      // execSync in shell mode (the call above), Node spawns `/bin/sh -c …`
      // which always succeeds (sh is found), so an ENOENT spawn failure is
      // unreachable here — the real signal is the shell exiting 127 ("command
      // not found"). The message regex catches mocked errors and odd shells
      // that don't propagate the status cleanly. NB: only the missing-binary
      // case becomes PROBE_UNAVAILABLE — probe crashes / non-zero exits stay
      // {ok: false} so real probe bugs surface.
      const probeMissing = status === 127
        || /commutativity-probe[^:]*:\s*(command )?not found/i.test(message);
      if (probeMissing) {
        log.warn('subprocess', { cmd: 'commutativity-probe', exit_code: status ?? -1, ms: subMs }, 'commutativity-probe binary not found on PATH');
        const body = buildFailSafeBody(
          args,
          mode,
          'PROBE_UNAVAILABLE',
          'commutativity-probe binary not found on PATH; install via mcp-server-sdlc/scripts/install-remote.sh or `pip install --user git+https://github.com/Wave-Engineering/commutativity-probe.git@v0.1.0`',
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body) }],
        };
      }

      // Real execSync timeouts set err.code === 'ETIMEDOUT'. Fall back to
      // substring match for mocked errors and older runtimes.
      const timedOut = code === 'ETIMEDOUT'
        || message.includes('ETIMEDOUT')
        || message.includes('timed out');
      if (timedOut) {
        log.warn('subprocess', { cmd: 'commutativity-probe', exit_code: -1, ms: subMs }, 'Subprocess timed out');
        const body = buildFailSafeBody(
          args,
          mode,
          'ORACLE_REQUIRED',
          `Subprocess timed out after ${timeoutMs}ms. Failing safe to ORACLE_REQUIRED.`,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body) }],
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
    const verdict = isProbeVerdict(probe.flight_verdict)
      ? probe.flight_verdict
      : 'ORACLE_REQUIRED';

    const warnings: string[] = [];
    if (!isProbeVerdict(probe.flight_verdict)) {
      warnings.push(`Unknown verdict '${probe.flight_verdict}' from probe — defaulting to ORACLE_REQUIRED`);
    }

    // Validate per-pair verdicts. Expected empty in single-target mode — if
    // a future probe version deviates, drop the pairs and emit a warning
    // rather than producing a contradictory response with both
    // single_target_result and pairwise_results populated.
    let pairs = mapPairIds(probe.pairs, refToId).map(p => ({
      ...p,
      verdict: isProbeVerdict(p.verdict) ? p.verdict : 'ORACLE_REQUIRED',
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
