import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// This handler uses Bun.spawnSync to invoke gh/glab/git. Tests create
// fixture directories and PATH-stub executable shell scripts that stand
// in for gh/glab/git. No module mocks — same philosophy as
// dod_run_test_suite / drift_check_path_exists.

const { default: handler } = await import('../handlers/pr_create.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

let fixtureDir = '';
let stubBinDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;
const ORIGINAL_PATH = process.env.PATH;

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
  if (ORIGINAL_PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = ORIGINAL_PATH;
  }
}

async function makeFixture(
  files: Record<string, string>,
): Promise<{ fixture: string; stubBin: string }> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const fixture = `/tmp/pr-create-fix-${stamp}`;
  const stubBin = `/tmp/pr-create-bin-${stamp}`;
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(`${fixture}/${name}`, content);
  }
  // Ensure stubBin dir exists with a sentinel.
  await Bun.write(`${stubBin}/.keep`, '');
  return { fixture, stubBin };
}

async function writeStub(stubBin: string, name: string, script: string): Promise<void> {
  const path = `${stubBin}/${name}`;
  await Bun.write(path, `#!/usr/bin/env bash\n${script}\n`);
  const chmod = Bun.spawnSync({ cmd: ['chmod', '+x', path] });
  if (chmod.exitCode !== 0) {
    throw new Error(`chmod +x ${path} failed`);
  }
}

function activate(fixture: string, stubBin: string) {
  process.env.CLAUDE_PROJECT_DIR = fixture;
  // Keep /usr/bin + /bin in PATH for coreutils (cat, printf, chmod, sh).
  process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;
}

describe('pr_create handler', () => {
  beforeEach(() => {
    fixtureDir = '';
    stubBinDir = '';
  });
  afterEach(() => {
    fixtureDir = '';
    stubBinDir = '';
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('pr_create');
    expect(typeof handler.execute).toBe('function');
  });

  test('github_happy_path — creates PR and returns normalized response', async () => {
    const { fixture, stubBin } = await makeFixture({
      '.claude-project.md': '# platform: github\n',
    });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    // git branch --show-current → default to an expected head branch.
    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\tgit@github.com:org/repo.git (fetch)" ;;
  *) echo "unhandled git: $*" >&2; exit 1 ;;
esac
`,
    );

    // gh stub: pr create prints the URL; pr view prints JSON.
    await writeStub(
      stubBin,
      'gh',
      `
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/org/repo/pull/42"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat <<'EOF'
{"number":42,"url":"https://github.com/org/repo/pull/42","state":"OPEN","headRefName":"feature/76-pr-create","baseRefName":"main"}
EOF
  exit 0
fi
echo "unhandled gh: $*" >&2; exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    expect(data.state).toBe('open');
    expect(data.head).toBe('feature/76-pr-create');
    expect(data.base).toBe('main');
    expect(data.created).toBe(true);
  });

  test('gitlab_happy_path — creates MR and returns normalized response', async () => {
    const { fixture, stubBin } = await makeFixture({
      '.claude-project.md': '# platform: gitlab\n',
    });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\tgit@gitlab.com:org/repo.git (fetch)" ;;
  *) echo "unhandled git: $*" >&2; exit 1 ;;
esac
`,
    );

    await writeStub(
      stubBin,
      'glab',
      `
if [ "$1" = "mr" ] && [ "$2" = "create" ]; then
  echo "https://gitlab.com/org/repo/-/merge_requests/7"
  exit 0
fi
if [ "$1" = "mr" ] && [ "$2" = "view" ]; then
  cat <<'EOF'
{"iid":7,"web_url":"https://gitlab.com/org/repo/-/merge_requests/7","state":"opened","source_branch":"feature/76-pr-create","target_branch":"main"}
EOF
  exit 0
fi
echo "unhandled glab: $*" >&2; exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(7);
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/7');
    expect(data.state).toBe('open');
    expect(data.head).toBe('feature/76-pr-create');
    expect(data.base).toBe('main');
    expect(data.created).toBe(true);
  });

  test('draft_flag_github — passes --draft to gh pr create', async () => {
    const { fixture, stubBin } = await makeFixture({
      '.claude-project.md': '# platform: github\n',
    });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\tgit@github.com:org/repo.git (fetch)" ;;
  *) exit 1 ;;
esac
`,
    );

    // Record args into a side-channel file for inspection.
    const recordPath = `${fixture}/gh-args.txt`;
    await writeStub(
      stubBin,
      'gh',
      `
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${recordPath}"
  echo "https://github.com/org/repo/pull/99"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat <<'EOF'
{"number":99,"url":"https://github.com/org/repo/pull/99","state":"OPEN","headRefName":"feature/76-pr-create","baseRefName":"main"}
EOF
  exit 0
fi
exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      draft: true,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const recorded = await Bun.file(recordPath).text();
    expect(recorded).toContain('--draft');
  });

  test('draft_flag_gitlab — passes --draft to glab mr create', async () => {
    const { fixture, stubBin } = await makeFixture({
      '.claude-project.md': '# platform: gitlab\n',
    });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\tgit@gitlab.com:org/repo.git (fetch)" ;;
  *) exit 1 ;;
esac
`,
    );

    const recordPath = `${fixture}/glab-args.txt`;
    await writeStub(
      stubBin,
      'glab',
      `
if [ "$1" = "mr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "${recordPath}"
  echo "https://gitlab.com/org/repo/-/merge_requests/8"
  exit 0
fi
if [ "$1" = "mr" ] && [ "$2" = "view" ]; then
  cat <<'EOF'
{"iid":8,"web_url":"https://gitlab.com/org/repo/-/merge_requests/8","state":"opened","source_branch":"feature/76-pr-create","target_branch":"main"}
EOF
  exit 0
fi
exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      draft: true,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const recorded = await Bun.file(recordPath).text();
    expect(recorded).toContain('--draft');
  });

  test('missing_required_title — schema rejects', async () => {
    const result = await handler.execute({ body: 'b', base: 'main' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('title');
  });

  test('missing_required_body — schema rejects', async () => {
    const result = await handler.execute({ title: 't', base: 'main' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('body');
  });

  test('missing_required_base — schema rejects', async () => {
    const result = await handler.execute({ title: 't', body: 'b' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('base');
  });

  test('explicit_head_overrides_git_branch — uses args.head when provided', async () => {
    const { fixture, stubBin } = await makeFixture({
      '.claude-project.md': '# platform: github\n',
    });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    // git stub that would fail if called with branch --show-current, proving
    // the handler used args.head directly.
    await writeStub(
      stubBin,
      'git',
      `
if [ "$1" = "branch" ]; then
  echo "git branch should not be called when head is provided" >&2
  exit 99
fi
if [ "$1" = "remote" ]; then
  echo "origin\tgit@github.com:org/repo.git (fetch)"
  exit 0
fi
exit 1
`,
    );

    await writeStub(
      stubBin,
      'gh',
      `
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/org/repo/pull/55"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat <<'EOF'
{"number":55,"url":"https://github.com/org/repo/pull/55","state":"OPEN","headRefName":"custom-head","baseRefName":"main"}
EOF
  exit 0
fi
exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      head: 'custom-head',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.head).toBe('custom-head');
  });

  test('github_error_path — gh pr create fails, returns ok=false with error', async () => {
    const { fixture, stubBin } = await makeFixture({
      '.claude-project.md': '# platform: github\n',
    });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\tgit@github.com:org/repo.git (fetch)" ;;
  *) exit 1 ;;
esac
`,
    );

    await writeStub(
      stubBin,
      'gh',
      `
echo "authentication error: not logged in" >&2
exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh pr create failed');
    expect(String(data.error)).toContain('authentication error');
  });

  test('github_idempotent — duplicate PR returns existing with created=false', async () => {
    const { fixture, stubBin } = await makeFixture({ '.keep': '' });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\tgit@github.com:org/repo.git (fetch)" ;;
  *) exit 1 ;;
esac
`,
    );

    // gh pr create fails with "already exists"; gh pr list returns the existing PR.
    await writeStub(
      stubBin,
      'gh',
      `
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "a pull request for branch \"feature/76-pr-create\" into branch \"main\" already exists" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  cat <<'EOF'
[{"number":42,"url":"https://github.com/org/repo/pull/42","state":"OPEN","headRefName":"feature/76-pr-create","baseRefName":"main"}]
EOF
  exit 0
fi
echo "unhandled gh: $*" >&2; exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    expect(data.created).toBe(false);
  });

  test('gitlab_idempotent — duplicate MR returns existing with created=false', async () => {
    const { fixture, stubBin } = await makeFixture({ '.keep': '' });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\tgit@gitlab.com:org/repo.git (fetch)" ;;
  *) exit 1 ;;
esac
`,
    );

    // glab mr create fails with "already exists"; glab mr view returns the existing MR.
    await writeStub(
      stubBin,
      'glab',
      `
if [ "$1" = "mr" ] && [ "$2" = "create" ]; then
  echo "Another open merge request already exists for this source branch" >&2
  exit 1
fi
if [ "$1" = "mr" ] && [ "$2" = "view" ]; then
  cat <<'EOF'
{"iid":7,"web_url":"https://gitlab.com/org/repo/-/merge_requests/7","state":"opened","source_branch":"feature/76-pr-create","target_branch":"main"}
EOF
  exit 0
fi
echo "unhandled glab: $*" >&2; exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(7);
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/7');
    expect(data.created).toBe(false);
  });

  test('fallback_platform_detection — no .claude-project.md, uses git remote', async () => {
    const { fixture, stubBin } = await makeFixture({
      // Intentionally no .claude-project.md — handler must consult `git remote -v`.
      'README.md': '# project\n',
    });
    fixtureDir = fixture;
    stubBinDir = stubBin;

    await writeStub(
      stubBin,
      'git',
      `
case "$1 $2" in
  "branch --show-current") echo "feature/76-pr-create" ;;
  "remote -v") echo "origin\thttps://gitlab.com/org/repo.git (fetch)" ;;
  *) exit 1 ;;
esac
`,
    );

    await writeStub(
      stubBin,
      'glab',
      `
if [ "$1" = "mr" ] && [ "$2" = "create" ]; then
  echo "https://gitlab.com/org/repo/-/merge_requests/11"
  exit 0
fi
if [ "$1" = "mr" ] && [ "$2" = "view" ]; then
  cat <<'EOF'
{"iid":11,"web_url":"https://gitlab.com/org/repo/-/merge_requests/11","state":"opened","source_branch":"feature/76-pr-create","target_branch":"main"}
EOF
  exit 0
fi
exit 1
`,
    );

    activate(fixture, stubBin);

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(11);
  });
});
