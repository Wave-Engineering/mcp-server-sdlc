import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { log } from '../logger.js';

const fileEntrySchema = z.object({
  path: z.string().min(1),
  action: z.string().optional().default('modify'),
  symbols: z.array(z.string()).optional(),
});

const changesetSchema = z.object({
  id: z.string().min(1),
  files: z.array(fileEntrySchema),
});

const inputSchema = z.object({
  changesets: z
    .array(changesetSchema)
    .min(2, 'At least 2 changesets required for pairwise analysis'),
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

const SUBPROCESS_TIMEOUT_MS = 10_000;

export interface Deps {
  execFn: (cmd: string, input: string) => string;
}

function defaultExec(cmd: string, input: string): string {
  return execSync(cmd, {
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
    input,
  });
}

const defaultDeps: Deps = {
  execFn: defaultExec,
};

export async function runPredict(
  rawArgs: unknown,
  deps: Deps = defaultDeps,
): Promise<{
  ok: boolean;
  group_verdict?: string;
  pairs?: ProbePair[];
  warnings?: string[];
  error?: string;
}> {
  let args: Input;
  try {
    args = inputSchema.parse(rawArgs);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }

  const manifest = JSON.stringify({ changesets: args.changesets });
  const cmd = 'commutativity-probe predict --manifest --json';

  let raw: string;
  const subStart = Date.now();
  try {
    raw = deps.execFn(cmd, manifest);
    log.info('subprocess', {
      cmd: 'commutativity-probe',
      exit_code: 0,
      ms: Date.now() - subStart,
    });
  } catch (err) {
    const subMs = Date.now() - subStart;
    const message = err instanceof Error ? err.message : String(err);
    const timedOut =
      message.includes('ETIMEDOUT') || message.includes('timed out');
    if (timedOut) {
      log.warn(
        'subprocess',
        { cmd: 'commutativity-probe', exit_code: -1, ms: subMs },
        'Subprocess timed out',
      );
      return {
        ok: true,
        group_verdict: 'ORACLE_REQUIRED',
        pairs: [],
        warnings: [
          `Subprocess timed out after ${SUBPROCESS_TIMEOUT_MS}ms. Failing safe to ORACLE_REQUIRED.`,
        ],
      };
    }
    log.error('subprocess', {
      cmd: 'commutativity-probe',
      exit_code: -1,
      ms: subMs,
      stderr: message.slice(0, 200),
    });
    return {
      ok: false,
      error: `commutativity-probe predict failed: ${message}`,
    };
  }

  let probe: ProbeOutput;
  try {
    probe = JSON.parse(raw) as ProbeOutput;
  } catch {
    return {
      ok: false,
      error: 'Failed to parse commutativity-probe JSON output',
    };
  }

  const groupVerdict = isValidVerdict(probe.flight_verdict)
    ? probe.flight_verdict
    : 'ORACLE_REQUIRED';

  const warnings: string[] = [];
  if (!isValidVerdict(probe.flight_verdict)) {
    warnings.push(
      `Unknown verdict '${probe.flight_verdict}' from probe — defaulting to ORACLE_REQUIRED`,
    );
  }

  const pairs = probe.pairs.map((p) => ({
    ...p,
    verdict: isValidVerdict(p.verdict) ? p.verdict : 'ORACLE_REQUIRED',
  }));

  return {
    ok: true,
    group_verdict: groupVerdict,
    pairs,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

const commutativityPredictHandler: HandlerDef = {
  name: 'commutativity_predict',
  description:
    'Predict changeset commutativity from planning manifests (file paths, actions, symbols) ' +
    'WITHOUT requiring actual git branches or diffs. Returns STRONG/MEDIUM/WEAK/ORACLE_REQUIRED. ' +
    'Call during flight planning to inform partition decisions. ' +
    'commutativity_verify at merge time remains the definitive safety net.',
  inputSchema,
  async execute(rawArgs: unknown) {
    const result = await runPredict(rawArgs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  },
};

export default commutativityPredictHandler;
