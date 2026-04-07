import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  command: z.string().optional(),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function discoverTestCommand(root: string): Promise<string | null> {
  if (await fileExists(`${root}/scripts/ci/test.sh`)) {
    return './scripts/ci/test.sh';
  }
  if (await fileExists(`${root}/package.json`)) {
    try {
      const pkg = (await Bun.file(`${root}/package.json`).json()) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      if (pkg.scripts?.test) {
        return 'npm test';
      }
    } catch {
      // fall through
    }
    // Default to bun test if package.json exists but no test script.
    return 'bun test';
  }
  if (await fileExists(`${root}/pytest.ini`) || await fileExists(`${root}/pyproject.toml`)) {
    return 'pytest';
  }
  return null;
}

interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
}

function parseBunOutput(output: string): TestResult {
  // bun test summary lines: " NN pass", " NN fail", " NN skip"
  const passMatch = /(\d+)\s+pass/.exec(output);
  const failMatch = /(\d+)\s+fail/.exec(output);
  const skipMatch = /(\d+)\s+skip/.exec(output);
  return {
    passed: passMatch ? parseInt(passMatch[1], 10) : 0,
    failed: failMatch ? parseInt(failMatch[1], 10) : 0,
    skipped: skipMatch ? parseInt(skipMatch[1], 10) : 0,
  };
}

function parsePytestOutput(output: string): TestResult {
  // pytest summary: "NN passed, NN failed, NN skipped"
  const passMatch = /(\d+)\s+passed/.exec(output);
  const failMatch = /(\d+)\s+failed/.exec(output);
  const skipMatch = /(\d+)\s+skipped/.exec(output);
  return {
    passed: passMatch ? parseInt(passMatch[1], 10) : 0,
    failed: failMatch ? parseInt(failMatch[1], 10) : 0,
    skipped: skipMatch ? parseInt(skipMatch[1], 10) : 0,
  };
}

function parseTestOutput(command: string, output: string): TestResult {
  if (command.includes('bun test')) return parseBunOutput(output);
  if (command.includes('pytest')) return parsePytestOutput(output);
  // Generic best-effort: try bun format first, fall back to pytest format.
  const bun = parseBunOutput(output);
  if (bun.passed + bun.failed + bun.skipped > 0) return bun;
  return parsePytestOutput(output);
}

function runCommand(cmd: string, cwd: string): { exitCode: number; output: string; durationMs: number } {
  const start = Date.now();
  const proc = Bun.spawnSync({
    cmd: ['sh', '-c', cmd],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out =
    new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  return {
    exitCode: proc.exitCode ?? -1,
    output: out,
    durationMs: Date.now() - start,
  };
}

const dodRunTestSuiteHandler: HandlerDef = {
  name: 'dod_run_test_suite',
  description: "Discover and run the project's test command, return structured pass/fail counts",
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
      const root = projectDir();
      const command = args.command ?? (await discoverTestCommand(root));
      if (!command) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'no test command found (looked for scripts/ci/test.sh, package.json, pytest.ini)',
              }),
            },
          ],
        };
      }

      const { exitCode, output, durationMs } = runCommand(command, root);
      const parsed = parseTestOutput(command, output);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              command,
              exit_code: exitCode,
              passed: parsed.passed,
              failed: parsed.failed,
              skipped: parsed.skipped,
              duration_ms: durationMs,
              raw_output: output,
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

export default dodRunTestSuiteHandler;
