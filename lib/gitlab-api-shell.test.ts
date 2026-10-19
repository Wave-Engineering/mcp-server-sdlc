/**
 * The GitLab list wrappers survive a REAL shell (#585).
 *
 * `execGlab` used to hand `/bin/sh` one string, `glab api …?ref=x&per_page=20`.
 * The shell read the `&` as the background operator: glab went to the
 * background, the shell exited at once, and stdout came back empty. #428's
 * "empty output means no results" then made that an authoritative `[]`, so
 * `ci_wait_run` never saw a GitLab pipeline. Every query with two or more params
 * was affected.
 *
 * The mocked suite could not see it, and still can't: the shared exec mock
 * unquotes commands before matching, and several tests registered the buggy
 * string verbatim. So these tests run the real `execGlab` and the real shell
 * against a stub `glab` first on PATH. The stub records the argv it actually
 * received, which is the only place the bug was ever visible.
 *
 * Each test runs in a fresh `bun -e`: `child_process` is mocked process-wide
 * by sibling files (#456), and in-process this would run against their mock.
 * No `node:fs` for the same reason (`lib/test-support/mock-fs.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const GITLAB_API = join(import.meta.dir, 'gitlab-api.ts');

// Prints one pipeline or MR, or nothing when GLAB_EMPTY is set. Each call's argv
// goes to the log, one element per line, after a CALL marker.
const GLAB_STUB = `#!/usr/bin/env bash
{ echo CALL; printf '%s\\n' "$@"; } >> "$GLAB_LOG"
[ -n "$GLAB_EMPTY" ] && exit 0
case "$2" in
  */pipelines*) printf '%s' '[{"id":7,"sha":"abc","ref":"release/1.2.3","status":"success","web_url":"u"}]' ;;
  */merge_requests*) printf '%s' '[{"iid":3,"title":"t","state":"merged","source_branch":"s","target_branch":"main","web_url":"u","labels":[]}]' ;;
  *) exit 9 ;;
esac
`;

let root: string;

function sh(...argv: string[]): string {
  const p = Bun.spawnSync(argv);
  if (p.exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

beforeEach(async () => {
  root = sh('mktemp', '-d', `${process.env.TMPDIR || '/tmp'}/sdlc-glab-shell-XXXXXX`).trim();
  await Bun.write(join(root, 'bin', 'glab'), GLAB_STUB);
  await Bun.write(join(root, 'glab.log'), '');
  sh('chmod', '755', join(root, 'bin', 'glab'));
});

afterEach(() => {
  sh('rm', '-rf', root);
});

/** Run `body` in a fresh bun with the stub glab first on PATH; return stdout and the calls glab saw. */
function run(body: string, env: Record<string, string> = {}): { out: string; calls: string[][] } {
  const src = `
    import { gitlabApiCiList, gitlabApiMrList } from '${GITLAB_API}';
    try { ${body} } catch (e) { console.log('THREW:' + String(e)); }
  `;
  const proc = Bun.spawnSync(['bun', '-e', src], {
    cwd: root,
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GLAB_LOG: join(root, 'glab.log'), ...env },
  });
  const log = sh('cat', join(root, 'glab.log'));
  const calls = log.split('CALL\n').filter(Boolean).map((c) => c.replace(/\n$/, '').split('\n'));
  return { out: proc.stdout.toString() + proc.stderr.toString(), calls };
}

describe('gitlab list wrappers through a real shell (#585)', () => {
  test('a pipelines query with ref and per_page reaches glab whole and returns its pipeline', () => {
    const r = run(
      `console.log('N:' + gitlabApiCiList({ ref: 'release/1.2.3', limit: 20 }, { owner: 'group/sub/sub', repo: 'project' }).length);`,
    );
    expect(r.out).toContain('N:1');
    expect(r.calls).toEqual([['api', 'projects/group%2Fsub%2Fsub%2Fproject/pipelines?ref=release%2F1.2.3&per_page=20']]);
  });

  test('an MR query with state and per_page returns its MR (the issue\'s limit:50 → 0 case)', () => {
    const r = run(`console.log('N:' + gitlabApiMrList({ state: 'merged', limit: 50 }, { owner: 'group', repo: 'project' }).length);`);
    expect(r.out).toContain('N:1');
    expect(r.calls).toEqual([['api', 'projects/group%2Fproject/merge_requests?state=merged&per_page=50']]);
  });

  test('characters encodeURIComponent leaves alone reach glab intact', () => {
    // `(`, `)` and `'` are legal in a git branch name and survive encodeURIComponent.
    // Through an unquoted shell string, `(` was a syntax error.
    const r = run(`console.log('N:' + gitlabApiMrList({ head: "fix/(it's)", state: 'open' }, { owner: 'group', repo: 'project' }).length);`);
    expect(r.out).toContain('N:1');
    expect(r.calls).toEqual([['api', "projects/group%2Fproject/merge_requests?state=opened&source_branch=fix%2F(it's)"]]);
  });

  test('empty stdout from glab fails loud instead of reading as an empty list', () => {
    const ci = run(`gitlabApiCiList({ ref: 'main', limit: 1 }, { owner: 'g', repo: 'p' }); console.log('NO_THROW');`, { GLAB_EMPTY: '1' });
    expect(ci.out).toContain('THREW:');
    expect(ci.out).toContain('glab returned empty output');
    expect(ci.out).not.toContain('NO_THROW');
    const mr = run(`gitlabApiMrList({ state: 'open', limit: 1 }, { owner: 'g', repo: 'p' }); console.log('NO_THROW');`, { GLAB_EMPTY: '1' });
    expect(mr.out).toContain('glab returned empty output');
    expect(mr.out).not.toContain('NO_THROW');
  });
});
