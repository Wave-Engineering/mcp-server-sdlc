import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { buildGraph, type DepNode } from '../lib/dependency_graph';
import { detectPlatform, parseRepoSlug, gitlabApiIssue } from '../lib/glab.js';
import { execSync } from 'child_process';

const inputSchema = z
  .object({
    issue_refs: z.array(z.string().min(1)).optional(),
    epic_ref: z.string().min(1).optional(),
  })
  .refine(
    data => Boolean(data.issue_refs) !== Boolean(data.epic_ref),
    'provide exactly one of issue_refs or epic_ref',
  );

function fetchIssue(ref: IssueRef): { body: string; title: string } {
  const platform = detectPlatform();
  if (platform === 'github') {
    const repoArg = ref.owner && ref.repo ? `--repo ${ref.owner}/${ref.repo}` : '';
    const cmd = `gh issue view ${ref.number} ${repoArg} --json body,title`.trim();
    const raw = execSync(cmd, { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as { body?: string; title: string };
    return { body: parsed.body ?? '', title: parsed.title };
  }
  const result = gitlabApiIssue(ref.number, ref.owner && ref.repo ? { owner: ref.owner, repo: ref.repo } : undefined);
  return { body: result.description ?? '', title: result.title };
}

function normalizeRef(ref: string, currentSlug: string | null): string {
  const urlM =
    /https?:\/\/(?:github\.com|gitlab\.com)\/([^\s/]+)\/([^\s/]+)\/(?:-\/)?issues\/(\d+)/.exec(
      ref,
    );
  if (urlM) return `${urlM[1]}/${urlM[2]}#${urlM[3]}`;
  const crossM = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (crossM) return ref;
  const shortM = /^#?(\d+)$/.exec(ref);
  if (shortM) return currentSlug ? `${currentSlug}#${shortM[1]}` : `#${shortM[1]}`;
  return ref;
}

function parseDependencies(section: string, currentSlug: string | null): string[] {
  if (!section || /^none\b/i.test(section.trim())) return [];
  const found = new Set<string>();
  const urlRe =
    /https?:\/\/(?:github\.com|gitlab\.com)\/([^\s/]+)\/([^\s/]+)\/(?:-\/)?issues\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(section)) !== null) {
    found.add(`${m[1]}/${m[2]}#${m[3]}`);
  }
  const crossRe = /\b([^\s/#]+)\/([^\s/#]+)#(\d+)\b/g;
  while ((m = crossRe.exec(section)) !== null) {
    if (m[1].startsWith('http') || m[1].includes('.')) continue;
    found.add(`${m[1]}/${m[2]}#${m[3]}`);
  }
  const shortRe = /(?<![/\w])#(\d+)\b/g;
  while ((m = shortRe.exec(section)) !== null) {
    found.add(currentSlug ? `${currentSlug}#${m[1]}` : `#${m[1]}`);
  }
  return Array.from(found);
}

function resolveIssueList(
  issueRefs: string[] | undefined,
  epicRef: string | undefined,
  slug: string | null,
): string[] {
  if (issueRefs) return issueRefs.map(r => normalizeRef(r, slug));
  if (!epicRef) return [];
  const ref = parseIssueRef(epicRef);
  if (!ref) return [];
  const epic = fetchIssue(ref);
  const sections = parseSections(epic.body).sections;
  const subSection =
    sections.sub_issues ?? sections.subissues ?? sections.children ?? sections.tasks ?? '';
  const refs: string[] = [];
  const re = /(?:^|\s)([^/\s#]+\/[^/\s#]+#\d+|https?:\/\/\S+\/issues\/\d+|#\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(subSection)) !== null) {
    refs.push(normalizeRef(m[1], slug));
  }
  const seen = new Set<string>();
  return refs.filter(r => !seen.has(r) && (seen.add(r), true));
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
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const slug = parseRepoSlug();
      const refs = resolveIssueList(args.issue_refs, args.epic_ref, slug);
      if (refs.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                nodes: [],
                edges: [],
                fetched_count: 0,
              }),
            },
          ],
        };
      }

      const nodes: DepNode[] = [];
      const failures: string[] = [];
      let fetchedCount = 0;

      for (const ref of refs) {
        const parsed = parseIssueRef(ref);
        if (!parsed) continue;
        try {
          const data = fetchIssue(parsed);
          const sections = parseSections(data.body).sections;
          nodes.push({
            ref,
            title: data.title,
            depends_on: parseDependencies(sections.dependencies ?? '', slug),
          });
          fetchedCount++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          failures.push(`failed to fetch ${ref}: ${errorMsg}`);
        }
      }

      // If ALL fetches failed, return ok: false
      if (fetchedCount === 0 && refs.length > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `all ${refs.length} spec fetches failed: ${failures[0] ?? 'unknown error'}`,
                issue_count: refs.length,
                fetched_count: 0,
              }),
            },
          ],
        };
      }

      const graph = buildGraph(nodes);
      const response: {
        ok: true;
        nodes: typeof graph.nodes;
        edges: typeof graph.edges;
        fetched_count: number;
        warnings?: string[];
      } = {
        ok: true,
        nodes: graph.nodes,
        edges: graph.edges,
        fetched_count: fetchedCount,
      };

      // Add warnings if SOME fetches failed
      if (failures.length > 0) {
        response.warnings = failures;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(response),
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

export default waveDependencyGraphHandler;
