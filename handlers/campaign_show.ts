import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

interface CampaignState {
  project: string;
  current_stage: string | null;
  stages: Record<string, string>;
  deferrals: Array<{ item: string; reason: string; stage: string | null }>;
}

/**
 * Parse campaign-status `show` text output (no --json flag exists).
 *
 * Format:
 *   Project:      <name>
 *   Active Stage: <name|none>
 *   Stages:
 *     concept: <state>
 *     prd: <state>
 *     backlog: <state>
 *     implementation: <state>
 *     dod: <state>
 *   Deferrals:    N
 *     - <item>: <reason> (stage: <stage|None>)
 */
function parseShowOutput(text: string): CampaignState {
  const state: CampaignState = {
    project: '',
    current_stage: null,
    stages: {},
    deferrals: [],
  };

  const lines = text.split('\n');
  let inStages = false;
  let inDeferrals = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('Project:')) {
      state.project = line.substring('Project:'.length).trim();
      continue;
    }
    if (line.startsWith('Active Stage:')) {
      const v = line.substring('Active Stage:'.length).trim();
      state.current_stage = v === 'none' || v === '' ? null : v;
      continue;
    }
    if (line.startsWith('Stages:')) {
      inStages = true;
      inDeferrals = false;
      continue;
    }
    if (line.startsWith('Deferrals:')) {
      inStages = false;
      inDeferrals = true;
      continue;
    }
    if (inStages && line.startsWith('  ') && line.includes(':')) {
      const stripped = line.trim();
      const idx = stripped.indexOf(':');
      const name = stripped.substring(0, idx).trim();
      const value = stripped.substring(idx + 1).trim();
      if (name.length > 0) {
        state.stages[name] = value;
      }
      continue;
    }
    if (inDeferrals && line.trim().startsWith('- ')) {
      // "  - <item>: <reason> (stage: <stage|None>)"
      //
      // Items may contain colons (e.g., "PROJ-123: title"), so greedy split:
      // peel off the "(stage: ...)" suffix first, then split the remainder on
      // the LAST ": " to separate item from reason.
      const body = line.trim().substring(2);
      const stageSuffix = body.match(/^(.*)\s+\(stage:\s*(.*?)\)\s*$/);
      if (stageSuffix) {
        const [, itemReason, stage] = stageSuffix;
        const lastColon = itemReason.lastIndexOf(': ');
        if (lastColon >= 0) {
          const item = itemReason.substring(0, lastColon);
          const reason = itemReason.substring(lastColon + 2);
          state.deferrals.push({
            item,
            reason,
            stage: stage === 'None' ? null : stage,
          });
        }
      }
      continue;
    }
  }

  return state;
}

const campaignShowHandler: HandlerDef = {
  name: 'campaign_show',
  description: 'Print current campaign state as structured JSON via campaign-status CLI',
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

    const root = resolveRoot(args.root);

    let output: string;
    try {
      output = execSync('campaign-status show', { encoding: 'utf8', cwd: root });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `campaign-status show failed: ${msg}` }),
          },
        ],
      };
    }

    const state = parseShowOutput(output);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            project: state.project,
            current_stage: state.current_stage,
            stages: state.stages,
            deferrals: state.deferrals,
          }),
        },
      ],
    };
  },
};

export default campaignShowHandler;
