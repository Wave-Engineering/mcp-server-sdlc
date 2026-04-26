// Wave-family handler — adapter-dispatching shell. Subprocess + platform
// branching live in lib/adapters/fetch-issue-{github,gitlab}.ts (Story 2.1,
// #295); wave-computation / sub-issue + dependency parsing live in
// lib/wave-compute.ts (Story 2.8, #302). This handler is dispatch + envelope
// only.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, type IssueRef } from '../lib/spec_parser';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';
import { computeWavesForEpic, type IssueFetcher } from '../lib/wave-compute.js';

const inputSchema = z.object({
  epic_ref: z.string().min(1, 'epic_ref must be a non-empty string'),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function repoSlug(ref: IssueRef): string | undefined {
  return ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : undefined;
}

const waveComputeHandler: HandlerDef = {
  name: 'wave_compute',
  description: "Compute dependency-ordered waves for an epic's sub-issues",
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const ref = parseIssueRef(args.epic_ref);
    if (!ref) {
      return envelope({ ok: false, error: `could not parse epic_ref: '${args.epic_ref}'` });
    }

    // Adapter-backed fetcher: throws on error so the lib's existing try/catch
    // contract (per-sub failures → warnings; epic failure → outer catch)
    // is preserved verbatim.
    const fetchIssue: IssueFetcher = async (r: IssueRef) => {
      const repo = r.owner && r.repo ? `${r.owner}/${r.repo}` : undefined;
      const result = await getAdapter({ repo }).fetchIssue({ number: r.number, repo });
      if ('platform_unsupported' in result) throw new Error(result.hint);
      if (!result.ok) throw new Error(result.error);
      return { body: result.data.body, title: result.data.title };
    };

    try {
      // Resolve bare `#N` refs against the EPIC's repo, not the MCP cwd.
      // Fall back to cwd's slug only when the epic_ref itself was bare.
      const slug = repoSlug(ref) ?? parseRepoSlug();
      const result = await computeWavesForEpic(args.epic_ref, ref, slug, fetchIssue);
      return envelope(result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return envelope({ ok: false, error });
    }
  },
};

export default waveComputeHandler;
