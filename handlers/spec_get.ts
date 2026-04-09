import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { detectPlatformForRef, gitlabApiIssue } from '../lib/glab';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

interface IssueInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
}

function fetchGithub(ref: IssueRef): IssueInfo {
  const repoArg = ref.owner && ref.repo ? `--repo ${ref.owner}/${ref.repo}` : '';
  const cmd = `gh issue view ${ref.number} ${repoArg} --json number,title,body,state,labels`.trim();
  const raw = execSync(cmd, { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as {
    number: number;
    title: string;
    body: string;
    state: string;
    labels: Array<{ name: string }>;
  };
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? '',
    state: parsed.state.toUpperCase(),
    labels: (parsed.labels ?? []).map(l => l.name),
  };
}

function fetchGitlab(ref: IssueRef): IssueInfo {
  const parsed = gitlabApiIssue(ref.number, ref.owner && ref.repo ? { owner: ref.owner, repo: ref.repo } : undefined);
  const state = parsed.state === 'opened' ? 'OPEN' : parsed.state.toUpperCase();
  return {
    number: parsed.iid,
    title: parsed.title,
    body: parsed.description ?? '',
    state,
    labels: parsed.labels,
  };
}

const specGetHandler: HandlerDef = {
  name: 'spec_get',
  description: 'Fetch an issue and return its body parsed into structured sections',
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
              error: `could not parse issue_ref: '${args.issue_ref}' (expected #N or org/repo#N)`,
            }),
          },
        ],
      };
    }

    try {
      const platform = detectPlatformForRef(ref);
      const info = platform === 'github' ? fetchGithub(ref) : fetchGitlab(ref);
      const { sections, order } = parseSections(info.body);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              number: info.number,
              title: info.title,
              state: info.state,
              labels: info.labels,
              body: info.body,
              sections,
              section_order: order,
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

export default specGetHandler;
