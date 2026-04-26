// Wave-family handler — adapter-dispatching shell. Subprocess + platform
// branching live in lib/adapters/fetch-issue-{github,gitlab}.ts (Story 2.1,
// #295); dependency-graph parsing + topology live in
// lib/wave-dependency-graph.ts (Story 2.9, #303). This handler is dispatch +
// envelope only.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, type IssueRef } from '../lib/spec_parser';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';
import type { IssueFetcher } from '../lib/wave-compute.js';
import { computeDependencyGraph } from '../lib/wave-dependency-graph.js';

const inputSchema = z
  .object({
    issue_refs: z.array(z.string().min(1)).optional(),
    epic_ref: z.string().min(1).optional(),
  })
  .refine(
    data => Boolean(data.issue_refs) !== Boolean(data.epic_ref),
    'provide exactly one of issue_refs or epic_ref',
  );

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function repoSlug(ref: IssueRef): string | undefined {
  return ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : undefined;
}

const waveDependencyGraphHandler: HandlerDef = {
  name: 'wave_dependency_graph',
  description: 'Return the dependency graph of an issue set as nodes and edges',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    // Adapter-backed fetcher: throws on error so the lib's per-sub try/catch
    // (failures → warnings; epic failure → outer catch) is preserved verbatim.
    const fetchIssue: IssueFetcher = async (r: IssueRef) => {
      const repo = repoSlug(r);
      const result = await getAdapter({ repo }).fetchIssue({ number: r.number, repo });
      if ('platform_unsupported' in result) throw new Error(result.hint);
      if (!result.ok) throw new Error(result.error);
      return { body: result.data.body, title: result.data.title };
    };

    try {
      // Resolve bare `#N` refs against the EPIC's repo (fallback to cwd slug
      // for bare epic refs). When invoked with issue_refs directly, there's no
      // epic context — use cwd slug.
      let slug: string | null = parseRepoSlug();
      if (args.epic_ref) {
        const epicParsed = parseIssueRef(args.epic_ref);
        if (epicParsed && epicParsed.owner && epicParsed.repo) {
          slug = `${epicParsed.owner}/${epicParsed.repo}`;
        }
      }
      const result = await computeDependencyGraph(
        args.issue_refs,
        args.epic_ref,
        slug,
        fetchIssue,
      );
      return envelope(result);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveDependencyGraphHandler;
