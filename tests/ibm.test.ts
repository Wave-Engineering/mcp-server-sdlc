import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../lib/test-support/mock-child-process.ts';

// --- Mock child_process.execSync at module level ---
// We intercept execSync via a registry so individual tests can override calls.
// The boundary is the shared child_process mock helper (#455); this file keeps
// its object-shaped `execRegistry` and routes it through the shared responder.

let execRegistry: Record<string, string> = {};
let execError: Error | null = null;

installChildProcessMock();

// Import AFTER the mock is registered
const { default: ibmHandler } = await import('../handlers/ibm.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  resetExecMock();
  execRegistry = {};
  execError = null;
  setExecMock((cmd: string) => {
    if (execError) throw execError;
    // Match by prefix/substring
    for (const [key, value] of Object.entries(execRegistry)) {
      if (cmd.includes(key)) return value;
    }
    throw new Error(`Unexpected exec call: ${cmd}`);
  });
});

describe('ibm handler', () => {
  // --- protected_branch_main ---
  test('protected_branch_main — returns error for main branch', async () => {
    execRegistry['git branch --show-current'] = 'main';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain("protected");
    // #448: the protected-branch guidance must use the singular convention too
    // (it previously hardcoded plural 'docs', contradicting the regex path).
    expect((data.error as string)).toContain("'doc/' not 'docs/'");
  });

  // --- protected_branch_release ---
  test('protected_branch_release — returns error for release/* branch', async () => {
    execRegistry['git branch --show-current'] = 'release/1.0';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain("protected");
  });

  // --- no_issue_in_branch ---
  test('no_issue_in_branch — branch without issue number returns unrecognized-prefix error', async () => {
    execRegistry['git branch --show-current'] = 'feat-no-number';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    // Distinct from an issue-linkage failure (#448): name the format + branch.
    expect(data.error as string).toContain("Branch 'feat-no-number'");
    expect(data.error as string).toContain('unrecognized prefix or missing issue number');
    expect(data.error as string).toContain("'doc/' not 'docs/'");
    expect(data.error as string).not.toContain('no linked issue');
  });

  // --- issue_open ---
  test('issue_open — open issue returns success response', async () => {
    const branch = 'feature/42-my-thing';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh issue view 42'] = JSON.stringify({
      state: 'OPEN',
      title: 'My Thing',
      url: 'https://github.com/org/repo/issues/42',
    });
    execRegistry['gh pr list --head'] = JSON.stringify([]);

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(42);
    expect(data.issue_title).toBe('My Thing');
    expect(data.issue_url).toBe('https://github.com/org/repo/issues/42');
    expect(data.branch).toBe(branch);
    expect(data.pr_url).toBeNull();
    expect((data.message as string)).toContain('issue #42 is open');
  });

  // --- issue_open with explicit branch arg ---
  test('issue_open — honours a provided branch arg (with explicit repo, the #475-safe form)', async () => {
    // A branch that is not the current checkout must carry an explicit repo — else
    // ibm refuses rather than resolve it against the wrong repository (#475).
    const branch = 'fix/99-some-fix';
    execRegistry['git branch --show-current'] = 'main';
    execRegistry['gh issue view 99'] = JSON.stringify({
      state: 'OPEN',
      title: 'Some Fix',
      url: 'https://github.com/org/repo/issues/99',
    });
    execRegistry['gh pr list --head'] = JSON.stringify([]);

    const result = await ibmHandler.execute({ branch, repo: 'org/repo' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(99);
  });

  // --- issue_closed ---
  test('issue_closed — closed issue returns warning response', async () => {
    const branch = 'feature/42-my-thing';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh issue view 42'] = JSON.stringify({
      state: 'CLOSED',
      title: 'My Thing',
      url: 'https://github.com/org/repo/issues/42',
    });

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect((data.warning as string)).toContain('closed');
    expect(data.issue_number).toBe(42);
    expect(data.branch).toBe(branch);
  });

  // --- pr_present ---
  test('pr_present — PR on branch is included in response', async () => {
    const branch = 'feature/42-my-thing';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh issue view 42'] = JSON.stringify({
      state: 'OPEN',
      title: 'My Thing',
      url: 'https://github.com/org/repo/issues/42',
    });
    execRegistry['gh pr list --head'] = JSON.stringify([
      { number: 7, url: 'https://github.com/org/repo/pull/7' },
    ]);

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.pr_url).toBe('https://github.com/org/repo/pull/7');
  });

  // --- all 6 type prefixes ---
  test('branch_types — feature, fix, chore, doc, bug, kahuna prefixes all parse correctly', async () => {
    const types = ['feature', 'fix', 'chore', 'doc', 'bug', 'kahuna'];

    for (const type of types) {
      const branch = `${type}/10-something`;
      execRegistry['git branch --show-current'] = branch;
      execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
      execRegistry['gh issue view 10'] = JSON.stringify({
        state: 'OPEN',
        title: 'Something',
        url: 'https://github.com/org/repo/issues/10',
      });
      execRegistry['gh pr list --head'] = JSON.stringify([]);

      const result = await ibmHandler.execute({});
      const data = parseResult(result.content);

      expect(data.ok).toBe(true);
      expect(data.issue_number).toBe(10);
    }
  });

  // --- plural docs/ rejected (regression guard for #381, message clarity #448) ---
  test('plural_docs_rejected — docs/ (plural) returns unrecognized-prefix error, not a linkage error', async () => {
    execRegistry['git branch --show-current'] = 'docs/42-some-doc';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    // #448: a plural/unknown prefix must read as a branch-name problem, not as
    // "no linked issue" — that misdirection sent an agent chasing work-items.
    expect(data.error as string).toContain('unrecognized prefix');
    expect(data.error as string).toContain("'doc/' not 'docs/'");
    // The regex fails before any issue lookup — no fetchIssue call is registered.
    expect(data.error as string).not.toContain('no linked issue');
  });

  // --- issue-not-found is distinct from an unrecognized prefix (#448) ---
  test('issue_lookup_failed — well-formed branch names the parsed issue number on lookup failure', async () => {
    const branch = 'feature/77-missing-issue';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    // 'gh issue view 77' is deliberately NOT registered → the adapter's
    // execSync throws, fetchIssueGithub bounds it into { ok:false }, and the
    // handler surfaces the issue-specific message.

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    // Issue-specific message: names #77 and signals the branch format was accepted.
    expect(data.error as string).toContain('references issue #77');
    expect(data.error as string).toContain('lookup failed');
    expect(data.error as string).not.toContain('unrecognized prefix');
  });

  // --- gitlab platform ---
  test('gitlab_platform — uses glab commands when origin is gitlab', async () => {
    const branch = 'feature/5-gitlab-test';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    // New API-based calls via lib/gitlab-api
    execRegistry['glab api projects/org%2Frepo/issues/5'] = JSON.stringify({
      iid: 5,
      state: 'opened',
      title: 'GitLab Test',
      web_url: 'https://gitlab.com/org/repo/-/issues/5',
      description: '',
      labels: [],
    });
    execRegistry['glab api projects/org%2Frepo/merge_requests'] = JSON.stringify([]);

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(5);
    expect(data.issue_url).toBe('https://gitlab.com/org/repo/-/issues/5');
  });
});

describe('#475 — the cross-repo FALSE PASS', () => {
  // The bug, verbatim from the field (2026-07-13):
  //
  //   Session cwd = claudecode-workflow. Agent working in gitlab-settings-automation,
  //   on branch chore/31-queue-less, linked to THAT repo's issue #31.
  //
  //   ibm({branch: 'chore/31-queue-less'}) parsed "31", looked it up in the CWD's
  //   repo, matched claudecode-workflow#31 ("feat(dashboard): theme tokens") — an
  //   entirely unrelated issue — and returned:
  //
  //     {"ok":true, ..., "message":"In order: issue #31 is open, branch is correctly linked"}
  //
  //   A confident FALSE PASS on the first gate of /precheck, which is a MANDATORY
  //   compliance check. The gate was not enforcing; it only looked like it was.

  test('a branch that is not checked out here, with no repo, is REFUSED — not guessed', async () => {
    execRegistry['git branch --show-current'] = 'main'; // we are standing somewhere else

    // Register a REAL open issue #31 in the cwd repo. This is what makes the
    // assertion load-bearing: WITHOUT the guard, the handler parses "31" from the
    // branch, looks it up here, finds this OPEN issue, and returns ok:true — the
    // exact field false pass. With the guard it must refuse BEFORE any lookup.
    execRegistry['gh issue view 31'] = JSON.stringify({
      number: 31,
      title: 'feat(dashboard): theme tokens', // the UNRELATED cwd-repo issue from the field
      url: 'https://github.com/Wave-Engineering/claudecode-workflow/issues/31',
      state: 'OPEN',
    });
    execRegistry['gh pr list --head'] = '[]';

    const result = await ibmHandler.execute({ branch: 'chore/31-queue-less' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false); // <-- would be `true` (false pass) without the guard
    expect(data.error as string).toMatch(/not the branch checked out here/i);
    expect(data.error as string).toMatch(/repo=/);
    // It must NOT have resolved the unrelated cwd-repo issue.
    expect(data.issue_number).toBeUndefined();
    expect(data.issue_title).toBeUndefined();
    expect(data.message).toBeUndefined();
  });

  test('a repo with no branch is REFUSED too (the other axis of #475)', async () => {
    // cwd is on feature/31-foo; caller names a DIFFERENT repo but no branch.
    // Defaulting the branch from cwd and checking it against that repo is the same
    // trap. An open #31 in the named repo would otherwise falsely pass.
    execRegistry['git branch --show-current'] = 'feature/31-foo';
    execRegistry['gh issue view 31'] = JSON.stringify({
      number: 31,
      title: 'unrelated issue in the other repo',
      url: 'u',
      state: 'OPEN',
    });
    execRegistry['gh pr list --head'] = '[]';

    const result = await ibmHandler.execute({ repo: 'other/repo' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(data.error as string).toMatch(/no 'branch'|but no 'branch'/i);
    expect(data.issue_number).toBeUndefined();
  });

  test('the same branch WITH an explicit repo is checked against THAT repo', async () => {
    execRegistry['git branch --show-current'] = 'main';
    execRegistry['gh issue view'] = JSON.stringify({
      number: 31,
      title: 'chore(settings): go queue-less',
      url: 'https://github.com/bakeb7j0/gitlab-settings-automation/issues/31',
      state: 'OPEN',
    });
    execRegistry['gh pr list'] = '[]';

    const result = await ibmHandler.execute({
      branch: 'chore/31-queue-less',
      repo: 'bakeb7j0/gitlab-settings-automation',
    });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(31);
    // The envelope echoes the repo actually checked, so the caller can SEE which
    // repository the verdict applies to rather than assuming it was theirs.
    expect(data.repo).toBe('bakeb7j0/gitlab-settings-automation');
  });

  test('the ordinary case still works: no branch arg → the checked-out branch', async () => {
    execRegistry['git branch --show-current'] = 'feature/900-x';
    execRegistry['gh issue view'] = JSON.stringify({
      number: 900,
      title: 'x',
      url: 'u',
      state: 'OPEN',
    });
    execRegistry['gh pr list'] = '[]';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(900);
  });

  test('an explicitly-passed branch that MATCHES the checkout is allowed without repo', async () => {
    execRegistry['git branch --show-current'] = 'fix/475-ibm-cwd-bound';
    execRegistry['gh issue view'] = JSON.stringify({
      number: 475,
      title: 'x',
      url: 'u',
      state: 'OPEN',
    });
    execRegistry['gh pr list'] = '[]';

    const result = await ibmHandler.execute({ branch: 'fix/475-ibm-cwd-bound' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true); // cwd IS the right repo — nothing to guess
    expect(data.issue_number).toBe(475);
  });
});
