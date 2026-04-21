import { execSync } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform, gitlabApiIssue, parseRepoSlug } from '../lib/glab';

const inputSchema = z.object({}).strict();

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function readJson(path: string): Promise<unknown> {
  return await Bun.file(path).json();
}

async function statusDir(root: string): Promise<string> {
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

interface PlanIssue {
  number: number;
}
interface PlanWave {
  id: string;
  issues?: PlanIssue[];
}
interface PlanPhase {
  waves?: PlanWave[];
}
interface PlanData {
  phases?: PlanPhase[];
}

interface WaveState {
  status?: string;
}

interface StateData {
  current_wave?: string | null;
  waves?: Record<string, WaveState>;
}

function flatWaveIds(plan: PlanData): string[] {
  const ids: string[] = [];
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      ids.push(wave.id);
    }
  }
  return ids;
}

function findWave(plan: PlanData, id: string): PlanWave | null {
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (wave.id === id) return wave;
    }
  }
  return null;
}

function findPreviousWaveId(plan: PlanData, state: StateData): string | null {
  const ids = flatWaveIds(plan);
  const current = state.current_wave;

  // If current_wave is set, previous is the one before it.
  if (current) {
    const idx = ids.indexOf(current);
    return idx > 0 ? ids[idx - 1] : null;
  }

  // If no current_wave, use the latest wave with status=completed.
  const waves = state.waves ?? {};
  for (let i = ids.length - 1; i >= 0; i--) {
    if (waves[ids[i]]?.status === 'completed') return ids[i];
  }
  return null;
}

interface IssueClosureInfo {
  state: 'OPEN' | 'CLOSED';
  closedByMergedPR: boolean;
}

// GraphQL query that returns both the closure state AND the linkage to any
// merging PR. `closedByPullRequestsReferences` captures body-keyword closures
// (`Closes #N`) which the REST events API misses (commit_id is null for those),
// while `timelineItems[ClosedEvent].closer` covers the broader "closed by a PR"
// timeline event. An issue counts as closed-via-merged-PR iff CLOSED and at
// least one linked PR is merged, OR the closer is explicitly a PullRequest.
const GH_ISSUE_CLOSURE_QUERY =
  'query($owner:String!,$repo:String!,$num:Int!)' +
  '{repository(owner:$owner,name:$repo){issue(number:$num){' +
  'state ' +
  'closedByPullRequestsReferences(first:5,includeClosedPrs:true){nodes{merged}} ' +
  'timelineItems(first:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{__typename}}}}' +
  '}}}';

interface GhGraphqlResponse {
  data?: {
    repository?: {
      issue?: {
        state?: string;
        closedByPullRequestsReferences?: { nodes?: Array<{ merged?: boolean }> };
        timelineItems?: { nodes?: Array<{ closer?: { __typename?: string } }> };
      };
    };
  };
}

// GitHub's owner/repo grammar: alphanumerics plus `.`, `_`, `-`. Enforcing this
// at the boundary prevents a maliciously-crafted git remote URL from smuggling
// shell metacharacters through `parseRepoSlug()` into the `execSync` string.
const GITHUB_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;

function fetchGithubClosureInfo(n: number, slug: string): IssueClosureInfo {
  const [owner, repo] = slug.split('/', 2);
  if (!owner || !repo) throw new Error(`invalid github slug: ${slug}`);
  if (!GITHUB_SLUG_SEGMENT.test(owner) || !GITHUB_SLUG_SEGMENT.test(repo)) {
    throw new Error(`invalid github slug characters: ${slug}`);
  }
  const cmd =
    `gh api graphql -f 'query=${GH_ISSUE_CLOSURE_QUERY}' ` +
    `-F owner=${owner} -F repo=${repo} -F num=${n}`;
  const raw = execSync(cmd, { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as GhGraphqlResponse;
  const issue = parsed.data?.repository?.issue;
  if (!issue) throw new Error(`github issue ${n} not found`);
  const state = (issue.state ?? '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
  if (state !== 'CLOSED') return { state: 'OPEN', closedByMergedPR: false };
  const prRefs = issue.closedByPullRequestsReferences?.nodes ?? [];
  const hasMergedPR = prRefs.some((ref) => ref?.merged === true);
  const closerIsPR =
    issue.timelineItems?.nodes?.[0]?.closer?.__typename === 'PullRequest';
  return { state: 'CLOSED', closedByMergedPR: hasMergedPR || closerIsPR };
}

// GitLab: `wave_previous_merged` still treats state-only as closed. The
// reported #183 repro was GitHub-specific (body-keyword closures); GitLab's
// default commit-trailer style populates closer info through a different path
// and hasn't been reported as broken. Leaving the GitLab code path untouched
// avoids a cross-platform regression; strengthening it to "closed by merged
// MR" is a separate feature.
function fetchGitlabClosureInfo(n: number): IssueClosureInfo {
  const parsed = gitlabApiIssue(n);
  const state = parsed.state === 'opened' ? 'OPEN' : 'CLOSED';
  return { state, closedByMergedPR: state === 'CLOSED' };
}

const wavePreviousMergedHandler: HandlerDef = {
  name: 'wave_previous_merged',
  description: "Verify the previous wave's issues are all closed via merged PRs",
  inputSchema,
  async execute(rawArgs: unknown) {
    try {
      inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const dir = await statusDir(projectDir());
      const planPath = join(dir, 'phases-waves.json');
      const statePath = join(dir, 'state.json');

      if (!(await fileExists(planPath)) || !(await fileExists(statePath))) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `state files not found in ${dir}`,
              }),
            },
          ],
        };
      }

      const plan = (await readJson(planPath)) as PlanData;
      const state = (await readJson(statePath)) as StateData;

      const prevId = findPreviousWaveId(plan, state);
      if (!prevId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                previous_wave_id: null,
                all_merged: true,
                open_issues: [],
              }),
            },
          ],
        };
      }

      const prevWave = findWave(plan, prevId);
      if (!prevWave) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `previous wave '${prevId}' not found in plan`,
              }),
            },
          ],
        };
      }

      const platform = detectPlatform();
      const githubSlug = platform === 'github' ? parseRepoSlug() : null;
      if (platform === 'github' && !githubSlug) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'could not parse github repo slug from origin url',
              }),
            },
          ],
        };
      }
      const openIssues: number[] = [];

      for (const issue of prevWave.issues ?? []) {
        try {
          const info =
            platform === 'github'
              ? fetchGithubClosureInfo(issue.number, githubSlug as string)
              : fetchGitlabClosureInfo(issue.number);
          if (info.state !== 'CLOSED' || !info.closedByMergedPR) {
            openIssues.push(issue.number);
          }
        } catch {
          openIssues.push(issue.number);
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              previous_wave_id: prevId,
              all_merged: openIssues.length === 0,
              open_issues: openIssues,
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

export default wavePreviousMergedHandler;
