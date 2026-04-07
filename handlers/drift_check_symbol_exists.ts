import { isAbsolute, join, extname } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const LANGS = ['python', 'typescript', 'javascript', 'go', 'rust', 'bash', 'auto'] as const;
type Lang = (typeof LANGS)[number];

const inputSchema = z.object({
  file_path: z.string().min(1, 'file_path must be a non-empty string'),
  symbol_name: z.string().min(1, 'symbol_name must be a non-empty string'),
  language: z.enum(LANGS).optional().default('auto'),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : join(projectDir(), path);
}

function detectLangFromExt(path: string): Exclude<Lang, 'auto'> | null {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.py':
      return 'python';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.sh':
    case '.bash':
      return 'bash';
    default:
      return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern(lang: Exclude<Lang, 'auto'>, name: string): RegExp {
  const n = escapeRe(name);
  switch (lang) {
    case 'python':
      return new RegExp(`^\\s*(def|class)\\s+${n}\\b`);
    case 'typescript':
    case 'javascript':
      return new RegExp(
        `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type)\\s+${n}\\b`,
      );
    case 'go':
      return new RegExp(
        `^\\s*(?:func(?:\\s*\\([^)]*\\))?|type|var|const)\\s+${n}\\b`,
      );
    case 'rust':
      return new RegExp(
        `^\\s*(?:pub\\s+)?(?:fn|struct|enum|trait|type|const|static)\\s+${n}\\b`,
      );
    case 'bash':
      return new RegExp(`^\\s*(?:function\\s+${n}\\s*\\(?|${n}\\s*\\(\\))`);
  }
}

const driftCheckSymbolExistsHandler: HandlerDef = {
  name: 'drift_check_symbol_exists',
  description: 'Grep for a symbol definition in a file',
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
      const abs = resolvePath(args.file_path);
      const file = Bun.file(abs);
      if (!(await file.exists())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `file not found: ${abs}`,
              }),
            },
          ],
        };
      }

      let lang: Exclude<Lang, 'auto'>;
      if (args.language === 'auto') {
        const detected = detectLangFromExt(abs);
        if (!detected) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: `could not detect language from file extension: ${abs}`,
                }),
              },
            ],
          };
        }
        lang = detected;
      } else {
        lang = args.language;
      }

      const pattern = buildPattern(lang, args.symbol_name);
      const text = await file.text();
      const lines = text.split('\n');
      let foundLine: number | null = null;
      let matchedLine: string | null = null;

      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          foundLine = i + 1;
          matchedLine = lines[i].trim();
          break;
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              file_path: args.file_path,
              symbol_name: args.symbol_name,
              language: lang,
              exists: foundLine !== null,
              line_number: foundLine,
              matched_pattern: matchedLine,
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

export default driftCheckSymbolExistsHandler;
