// DoD handler — adapter-dispatching shell (Story 2.7, #301).
// Platform branching + subprocess live in lib/adapters/fetch-issue-{github,gitlab}.ts.
// Markdown parsing lives in lib/dod-manifest-parser.ts (R-05 ≤80 lines).
// Closes #283: cross-repo `org/project#N` resolves on BOTH platforms via
// fetchIssue, eliminating the prior GitHub-only gap.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { extractManifestSection, parseManifestTable } from '../lib/dod-manifest-parser.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

const ISSUE_REF = /^([^/]+)\/([^/#]+)#(\d+)$/;
const SHORT_REF = /^#(\d+)$/;

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

async function fetchIssueBody(ref: string): Promise<string> {
  const m1 = ISSUE_REF.exec(ref);
  const m2 = SHORT_REF.exec(ref);
  if (m1) {
    const repo = `${m1[1]}/${m1[2]}`;
    const result = await getAdapter({ repo }).fetchIssue({ number: Number(m1[3]), repo });
    if ('platform_unsupported' in result) throw new Error(result.hint);
    if (!result.ok) throw new Error(result.error);
    return result.data.body;
  }
  if (m2) {
    const result = await getAdapter().fetchIssue({ number: Number(m2[1]) });
    if ('platform_unsupported' in result) throw new Error(result.hint);
    if (!result.ok) throw new Error(result.error);
    return result.data.body;
  }
  throw new Error(`unsupported issue ref format: ${ref}`);
}

async function readLocalFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`file not found: ${path}`);
  return await file.text();
}

function isIssueRef(path: string): boolean {
  return ISSUE_REF.test(path) || SHORT_REF.test(path);
}

const dodLoadManifestHandler: HandlerDef = {
  name: 'dod_load_manifest',
  description: 'Load and parse a Deliverables Manifest from a PRD file or issue reference',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const body = isIssueRef(args.path)
        ? await fetchIssueBody(args.path)
        : await readLocalFile(args.path);
      const section = extractManifestSection(body);
      if (section === null) {
        return envelope({ ok: false, error: 'no Deliverables Manifest section found in PRD' });
      }
      const { deliverables, warnings } = parseManifestTable(section);
      return envelope({ ok: true, deliverables, warnings, source: args.path });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default dodLoadManifestHandler;
