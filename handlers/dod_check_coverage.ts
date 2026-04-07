import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  threshold: z.number().min(0).max(100),
  coverage_file: z.string().optional(),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function discoverCoverageFile(root: string): Promise<string | null> {
  const candidates = [
    `${root}/coverage.xml`,
    `${root}/coverage/cobertura.xml`,
    `${root}/coverage.json`,
    `${root}/coverage/coverage-summary.json`,
  ];
  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }
  return null;
}

interface CoverageResult {
  percentage: number;
  files_below_threshold: Array<{ path: string; percentage: number }>;
}

/**
 * Parse a Cobertura-style XML file. Extracts line-rate attributes from
 * `<coverage>` (overall) and `<class filename="...">` elements.
 */
function parseCobertura(xml: string, threshold: number): CoverageResult {
  const overallMatch = /<coverage[^>]*\bline-rate="([\d.]+)"/.exec(xml);
  const overall = overallMatch ? parseFloat(overallMatch[1]) * 100 : 0;

  const files: Array<{ path: string; percentage: number }> = [];
  const classRe = /<class\s+([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(xml)) !== null) {
    const attrs = m[1];
    const fn = /filename="([^"]+)"/.exec(attrs);
    const lr = /line-rate="([\d.]+)"/.exec(attrs);
    if (fn && lr) {
      const pct = parseFloat(lr[1]) * 100;
      if (pct < threshold) {
        files.push({ path: fn[1], percentage: pct });
      }
    }
  }

  return { percentage: overall, files_below_threshold: files };
}

/**
 * Parse a JSON coverage summary in the Istanbul/Jest format:
 *   { total: { lines: { pct: 85.3 } }, "path/to/file.ts": { lines: { pct: 72 } }, ... }
 */
function parseJsonCoverage(obj: unknown, threshold: number): CoverageResult {
  const record = obj as Record<string, { lines?: { pct?: number } }>;
  const total = record.total?.lines?.pct ?? 0;

  const files: Array<{ path: string; percentage: number }> = [];
  for (const [key, val] of Object.entries(record)) {
    if (key === 'total') continue;
    const pct = val?.lines?.pct;
    if (typeof pct === 'number' && pct < threshold) {
      files.push({ path: key, percentage: pct });
    }
  }

  return { percentage: total, files_below_threshold: files };
}

const dodCheckCoverageHandler: HandlerDef = {
  name: 'dod_check_coverage',
  description: 'Measure test coverage and compare against a threshold',
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
      const file = args.coverage_file ?? (await discoverCoverageFile(root));
      if (!file) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'no coverage file found (looked for coverage.xml, coverage.json, coverage/...)',
              }),
            },
          ],
        };
      }

      if (!(await fileExists(file))) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `coverage file not found: ${file}`,
              }),
            },
          ],
        };
      }

      const content = await Bun.file(file).text();
      let result: CoverageResult;
      if (file.endsWith('.xml') || content.trimStart().startsWith('<')) {
        result = parseCobertura(content, args.threshold);
      } else {
        try {
          const obj = JSON.parse(content);
          result = parseJsonCoverage(obj, args.threshold);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: `failed to parse coverage JSON: ${error}`,
                }),
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              percentage: result.percentage,
              threshold: args.threshold,
              passed: result.percentage >= args.threshold,
              files_below_threshold: result.files_below_threshold,
              source: file,
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

export default dodCheckCoverageHandler;
