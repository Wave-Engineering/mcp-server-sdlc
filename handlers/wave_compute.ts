import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { computeWaves, type DepNode } from '../lib/dependency_graph';
import { detectPlatform, parseRepoSlug, gitlabApiIssue } from '../lib/glab.js';
import { execSync } from 'child_process';

const inputSchema = z.object({
  epic_ref: z.string().min(1, 'epic_ref must be a non-empty string'),
});

// Mirrors REQUIRED_SECTION_ALIASES in handlers/spec_validate_structure.ts (lines 14-18).
// Kept in lockstep so the story-self fallback applies the same "valid spec" test
// that /prepwaves uses upstream.
const REQUIRED_SECTION_ALIASES: Record<string, readonly string[]> = {
  changes: ['changes', 'implementation_steps'],
  tests: ['tests', 'test_procedures'],
  acceptance_criteria: ['acceptance_criteria'],
};

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

interface SubIssue {
  ref: string;
  title?: string;
}

function parseTableSubIssues(section: string, currentSlug: string | null): SubIssue[] {
  const lines = section.split('\n').map(l => l.trim());
  const subs: SubIssue[] = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('|') && lines[i].includes('|', 1)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];
  const headerCells = lines[headerIdx]
    .split('|')
    .slice(1, -1)
    .map(c => c.trim().toLowerCase());
  const issueCol = headerCells.findIndex(c => c.includes('issue'));
  const titleCol = headerCells.findIndex(c => c.includes('title'));

  let startRow = headerIdx + 1;
  if (startRow < lines.length && /^\|[\s\-:|]+\|$/.test(lines[startRow])) startRow += 1;

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const getCell = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : '');
    const issueRaw = getCell(issueCol);
    if (!issueRaw) continue;
    subs.push({
      ref: normalizeRef(issueRaw, currentSlug),
      title: titleCol >= 0 ? getCell(titleCol) || undefined : undefined,
    });
  }
  return subs;
}

function parseBulletSubIssues(section: string, currentSlug: string | null): SubIssue[] {
  const subs: SubIssue[] = [];
  const re = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    const refM =
      /(?:^|\s)([^/\s#]+\/[^/\s#]+#\d+|https?:\/\/\S+\/issues\/\d+|#\d+)/.exec(text);
    if (!refM) continue;
    const ref = normalizeRef(refM[1], currentSlug);
    const title = text.replace(refM[0], '').trim().replace(/^[-:*\s]+/, '').trim();
    subs.push({ ref, title: title || undefined });
  }
  return subs;
}

function parseDependencies(section: string, currentSlug: string | null): string[] {
  if (!section) return [];
  if (/^none\b/i.test(section.trim())) return [];
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
    const normalized = currentSlug ? `${currentSlug}#${m[1]}` : `#${m[1]}`;
    found.add(normalized);
  }
  return Array.from(found);
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
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    const ref = parseIssueRef(args.epic_ref);
    if (!ref) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `could not parse epic_ref: '${args.epic_ref}'`,
            }),
          },
        ],
      };
    }

    try {
      // Resolve bare `#N` refs against the EPIC's repo, not the MCP cwd.
      // Fall back to cwd's slug only when the epic_ref itself was bare.
      const slug =
        ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : parseRepoSlug();
      const epicData = fetchIssue(ref);
      const epicSections = parseSections(epicData.body).sections;
      const subIssuesSection =
        epicSections.sub_issues ??
        epicSections.subissues ??
        epicSections.children ??
        epicSections.tasks ??
        '';

      const subs = [
        ...parseTableSubIssues(subIssuesSection, slug),
        ...parseBulletSubIssues(subIssuesSection, slug),
      ];
      // Dedup by ref.
      const seen = new Set<string>();
      const dedupedSubs: SubIssue[] = [];
      for (const s of subs) {
        if (!seen.has(s.ref)) {
          seen.add(s.ref);
          dedupedSubs.push(s);
        }
      }

      // Story-self fallback: no sub-issues found → check whether the issue
      // itself is a valid spec. If so, treat it as a single-issue single-wave
      // plan. If not, error loudly (do NOT silently return an empty plan).
      if (dedupedSubs.length === 0) {
        const presence: Record<string, boolean> = {};
        for (const [canonical, aliases] of Object.entries(REQUIRED_SECTION_ALIASES)) {
          presence[`has_${canonical}`] = aliases.some(
            alias => epicSections[alias] && epicSections[alias].trim().length > 0,
          );
        }
        const specValid =
          presence.has_changes && presence.has_tests && presence.has_acceptance_criteria;
        if (!specValid) {
          const missing = Object.entries(REQUIRED_SECTION_ALIASES)
            .filter(([canonical]) => !presence[`has_${canonical}`])
            .map(([canonical]) => canonical);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: `no sub-issues found and epic spec is missing required sections: ${missing.join(', ')}`,
                  missing_sections: missing,
                }),
              },
            ],
          };
        }
        const selfRef = slug ? `${slug}#${ref.number}` : `#${ref.number}`;
        const selfNode: DepNode = {
          ref: selfRef,
          title: epicData.title,
          depends_on: [],
        };
        const selfResult = computeWaves([selfNode]);
        const selfResponse: {
          ok: true;
          epic_ref: string;
          waves: typeof selfResult.waves;
          topology: string;
          reason: string;
          total_issues: number;
          fetched_count: number;
          fallback_reason: string;
        } = {
          ok: true,
          epic_ref: args.epic_ref,
          waves: selfResult.waves,
          topology: selfResult.topology,
          reason: selfResult.reason,
          total_issues: selfResult.total_issues,
          fetched_count: 1,
          fallback_reason: 'story-self',
        };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(selfResponse) },
          ],
        };
      }

      // Fetch dependencies for each sub-issue.
      const nodes: DepNode[] = [];
      const failures: string[] = [];
      let fetchedCount = 0;

      for (const sub of dedupedSubs) {
        const subRefParsed = parseIssueRef(sub.ref);
        if (!subRefParsed) continue;
        try {
          const subData = fetchIssue(subRefParsed);
          const subSections = parseSections(subData.body).sections;
          // Use the sub-issue's own repo for resolving bare #N refs in ITS
          // deps section — a heterogeneous epic (sub-issue in a different
          // repo) has deps that live alongside the sub-issue, not the epic.
          const subSlug =
            subRefParsed.owner && subRefParsed.repo
              ? `${subRefParsed.owner}/${subRefParsed.repo}`
              : slug;
          const deps = parseDependencies(subSections.dependencies ?? '', subSlug);
          nodes.push({
            ref: sub.ref,
            title: sub.title ?? subData.title,
            depends_on: deps,
          });
          fetchedCount++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          failures.push(`failed to fetch ${sub.ref}: ${errorMsg}`);
        }
      }

      // If ALL fetches failed, return ok: false
      if (fetchedCount === 0 && dedupedSubs.length > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `all ${dedupedSubs.length} spec fetches failed: ${failures[0] ?? 'unknown error'}`,
                issue_count: dedupedSubs.length,
                fetched_count: 0,
              }),
            },
          ],
        };
      }

      const result = computeWaves(nodes);
      if (result.error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: result.error,
                waves: result.waves,
                total_issues: result.total_issues,
              }),
            },
          ],
        };
      }

      const response: {
        ok: true;
        epic_ref: string;
        waves: typeof result.waves;
        topology: string;
        reason: string;
        total_issues: number;
        fetched_count: number;
        warnings?: string[];
        fallback_reason?: string;
      } = {
        ok: true,
        epic_ref: args.epic_ref,
        waves: result.waves,
        topology: result.topology,
        reason: result.reason,
        total_issues: result.total_issues,
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

export default waveComputeHandler;
