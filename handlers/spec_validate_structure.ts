import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

const REQUIRED_SECTIONS = ['changes', 'tests', 'acceptance_criteria'] as const;
const OPTIONAL_SECTIONS = ['dependencies'] as const;

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    return url.includes('gitlab') ? 'gitlab' : 'github';
  } catch {
    return 'github';
  }
}

function fetchBody(ref: IssueRef): string {
  const platform = detectPlatform();
  if (platform === 'github') {
    const repoArg = ref.owner && ref.repo ? `--repo ${ref.owner}/${ref.repo}` : '';
    const cmd = `gh issue view ${ref.number} ${repoArg} --json body`.trim();
    const raw = execSync(cmd, { encoding: 'utf8' });
    return (JSON.parse(raw) as { body: string }).body ?? '';
  }
  const cmd =
    ref.owner && ref.repo
      ? `glab issue view ${ref.number} --repo ${ref.owner}/${ref.repo} --output json`
      : `glab issue view ${ref.number} --output json`;
  const raw = execSync(cmd, { encoding: 'utf8' });
  return (JSON.parse(raw) as { description?: string }).description ?? '';
}

const specValidateStructureHandler: HandlerDef = {
  name: 'spec_validate_structure',
  description: 'Check for presence of required sections in an issue spec',
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

    const ref = parseIssueRef(args.issue_ref);
    if (!ref) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `could not parse issue_ref: '${args.issue_ref}'`,
            }),
          },
        ],
      };
    }

    try {
      const body = fetchBody(ref);
      const { sections } = parseSections(body);

      const presence: Record<string, boolean> = {};
      const missing: string[] = [];
      for (const key of REQUIRED_SECTIONS) {
        const has = Boolean(sections[key] && sections[key].trim().length > 0);
        presence[`has_${key}`] = has;
        if (!has) missing.push(key);
      }
      for (const key of OPTIONAL_SECTIONS) {
        presence[`has_${key}`] = Boolean(
          sections[key] && sections[key].trim().length > 0,
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              issue_ref: args.issue_ref,
              ...presence,
              missing_sections: missing,
              valid: missing.length === 0,
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

export default specValidateStructureHandler;
