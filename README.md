# mcp-server-sdlc

SDLC workflow MCP server for Claude Code agents.

## Adapter architecture

This server is cross-platform — every tool that touches a code host (GitHub or GitLab) dispatches through a single typed **platform adapter** rather than shelling out to `gh` / `glab` inline. Handlers stay platform-agnostic: they resolve the adapter via `getAdapter()`, call one interface method, and unwrap a three-way `AdapterResult<T>` (`ok: true` for success, `ok: false` for runtime failure, `platform_unsupported: true` for structural cross-platform asymmetry). The third arm is what replaces the old silent-ignore bug class — e.g. `work_item(type: "mr")` on GitHub used to silently run the wrong sub-command; it now surfaces as an explicit typed signal (`{platform_unsupported: true, hint: 'use type="pr" on GitHub'}`, #281). Not every asymmetry gets this treatment, though — `skip_train: true` on GitLab (#423) is silently dropped with a `warnings` entry instead, since merge trains are auto-managed at the project level and there is no refusal to surface.

The canonical exemplars of the pattern live in `lib/adapters/pr-merge-github.ts` and `lib/adapters/pr-merge-gitlab.ts` (per R-03 of the retrofit dev spec) — one pair of per-method per-platform files, colocated `.test.ts` files mocking at the `child_process` boundary, and an assembler (`lib/adapters/github.ts` / `lib/adapters/gitlab.ts`) that wires them into the `PlatformAdapter` interface declared in `lib/adapters/types.ts`.

Two CI gate-greps (`scripts/ci/gate-greps.sh`) enforce the dispatch model: Gate 1 (R-09) forbids `platform === 'github' | 'gitlab'` branching inside `handlers/`, and Gate 2 (R-10) forbids direct `execSync('gh ...')` / `execSync('glab ...')` / `Bun.spawnSync` calls from handler files. A runtime contract test (`lib/adapters/types.test.ts`) additionally asserts that every method in `PLATFORM_ADAPTER_METHODS` is implemented on both adapters. See **[docs/adapters/README.md](docs/adapters/README.md)** for the full contract, file layout, dispatch model, hybrid sub-call pattern, testing conventions, and the guide for adding a new platform-aware method.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- A `GITHUB_TOKEN` or `GITLAB_TOKEN` environment variable (required for tools that interact with GitHub/GitLab APIs)
- **Python 3.11+** (optional, but required for `commutativity_verify` — see [commutativity-probe](#commutativity-probe) below)

## Quickstart

1. **Install the binary:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-sdlc/main/scripts/install-remote.sh | bash
   ```

   Install-time options:
   | Variable / flag | Effect |
   |---|---|
   | `SDLC_VERSION=v1.2.3` | Override sdlc-server release tag (default: latest release) |
   | `SDLC_PROBE_REF=<git-ref>` | Override commutativity-probe git ref (default: `v0.1.0`) |
   | `--skip-probe` | Skip commutativity-probe install (handler degrades to `verdict: PROBE_UNAVAILABLE`) |

2. **Configure your token** in `~/.claude.json` under the `sdlc-server` entry:
   ```json
   {
     "mcpServers": {
       "sdlc-server": {
         "command": "~/.local/bin/sdlc-server",
         "args": [],
         "env": {
           "GITHUB_TOKEN": "<your-token>"
         }
       }
     }
   }
   ```

3. **Restart Claude Code** to activate the server.

### Staying current — the deploy-freshness warning (#447)

The running binary and the latest release can silently drift apart. A stale
deploy once lagged the latest release by four merged fixes with **no signal
anywhere** — the only symptom was a confusing downstream failure miles from the
root cause.

To make that visible, the binary embeds its build commit SHA (via
`bun build --define` in `scripts/ci/build.sh`) and, **once at startup**, asks
GitHub whether that commit is behind this repo's latest release. If it is, it
emits a single `warn` line to stderr:

```json
{"level":"warn","event":"deploy_freshness","binary_sha":"081433d…",
 "latest_release":"v2.0.3","msg":"sdlc-server binary … is BEHIND the latest release v2.0.3 — redeploy with ./install --mcps"}
```

Seeing that line means: **redeploy.** Re-run the install command above (or
`./install --mcps` from the kit) to pull the current release binary.

Properties, by design:
- **Exact, not a date guess** — it uses GitHub's commit-compare API, so a
  same-day build that is genuinely current does not warn.
- **Network-optional** — offline, unauthenticated, or no-releases all degrade to
  **silence**. It never blocks startup and never spams.
- **No false alarms** — a build that is *newer* than the latest release (a local
  dev build) does not warn; neither does a dev build with no embedded SHA.
- **Self-scoped** — it checks the server against *its own* releases, independent
  of whichever project you are operating on.

If you build locally with `scripts/ci/build.sh`, the SHA is your working-tree
`HEAD`; a dev build ahead of the last release is silent, which is correct.

### Changelog (#459)

There is no maintained in-repo changelog. Release notes are auto-generated from
merged PR titles on the **[GitHub Releases](https://github.com/Wave-Engineering/mcp-server-sdlc/releases)**
page at tag time (`gh release create --generate-notes`), and the binary's startup
`version` reports the release tag it was built at. `CHANGELOG.md` is retired to a
pointer; pre-v2.1.0 hand-written history (including breaking-change migration notes)
lives in that file's git history.

## Handler Registry

Tools are auto-discovered at build time via a glob pattern over `handlers/`. To add a tool, drop a file in `handlers/` that exports a `HandlerDef` default. No other files need to change.

```typescript
// handlers/my_tool.ts
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const handler: HandlerDef = {
  name: 'my_tool',
  description: 'Does something useful',
  inputSchema: z.object({ input: z.string() }),
  execute: async (args) => ({
    content: [{ type: 'text', text: `Result: ${(args as { input: string }).input}` }],
  }),
};

export default handler;
```

## commutativity-probe

The `commutativity_verify` MCP tool shells out to the
[`commutativity-probe`](https://github.com/Wave-Engineering/commutativity-probe)
Python CLI to compute changeset commutativity from real git diffs. The
installer bundles it via `pip install --user` (pinned to `v0.1.0`).

If the probe binary is missing from `PATH`, `commutativity_verify` returns
the same body shape as a timeout, with `verdict: "PROBE_UNAVAILABLE"`:

```json
{
  "ok": true,
  "mode": "pairwise",
  "verdict": "PROBE_UNAVAILABLE",
  "group_verdict": "PROBE_UNAVAILABLE",
  "pairs": [],
  "pairwise_results": [],
  "warnings": ["commutativity-probe binary not found on PATH; install via mcp-server-sdlc/scripts/install-remote.sh"]
}
```

Callers should treat `PROBE_UNAVAILABLE` as conservative-fail (sequential
merge fallback) — equivalent to `ORACLE_REQUIRED` for dispatch purposes.

To install or upgrade the probe manually:

```bash
pip install --user 'git+https://github.com/Wave-Engineering/commutativity-probe.git@v0.1.0'
```

## Merge tools: `pr_merge` vs `pr_merge_wait`

Two tools, deliberately split by what the caller cares about:

| Tool | Returns | Use when |
|---|---|---|
| `pr_merge` | Eager — `enrolled:true` for a merge in progress (direct merge, or a queue enrollment on GitHub); `merged` reflects the moment-of-call truth (`true` for direct merge, `false` for queue path until the queue lands). On GitLab, `enrolled:false` with a `warnings` entry when the MR is blocked (approvals, unresolved discussions, draft) rather than in progress — see #461. On GitLab, a merge command that succeeds but whose post-merge state read fails outright (distinct from the propagation race #424 already retries past) returns `ok:false, code:"gitlab_mr_state_fetch_failed"` — the merge itself already landed; do not blind-retry `pr_merge` on this code, confirm via `pr_status` instead. | You need the platform to accept the merge, then keep working. Don't care exactly when the commit lands. |
| `pr_merge_wait` | Blocking — guarantees `merged:true, pr_state:"MERGED"` on success, or a timeout error. On GitLab, a pipeline-gated MR that its own `pr_merge` call would refuse instead enrolls (merge-when-pipeline-succeeds) and this tool polls it to completion — `merge_method:"merge_queue"` denotes that GitLab enrollment, not an actual queue (GitLab has none); an interim `enrolled:true, merged:false` response mid-wait carries that method the same way GitHub's queue path does — see #488. | You need the commit observable on `main` before the next step (e.g. `git pull`, post-merge CI, downstream wave work). |

Both return the same aggregate envelope:

```json
{
  "ok": true,
  "number": 42,
  "enrolled": true,
  "merged": false,
  "merge_method": "merge_queue",
  "queue": { "enabled": true, "position": null, "enforced": true },
  "pr_state": "OPEN",
  "url": "https://github.com/org/repo/pull/42",
  "warnings": []
}
```

### `skip_train` and merge-queue-enforced repos

When a repo enforces a merge queue via ruleset, GitHub ignores `skip_train`. Both tools detect this upfront and silently drop the flag, surfacing a `warnings[]` entry rather than erroring. On non-enforced repos `skip_train:true` honors the flag (direct merge, no queue fallback) — useful when `commutativity_verify` has proven the merge safe.

### Migrating callers

Pre-`v1.7.0` callers expected `pr_merge` to return `merged:true` after enrolling in the queue (eager-but-misleading). The new aggregate response always reflects the truth: `merged:false` until the commit is on main. Callers that need the old "wait for it" behavior should switch to `pr_merge_wait`.

## Tool Reference

See [docs/tool-reference.md](docs/tool-reference.md) _(coming soon)_.
