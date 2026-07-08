// branch_guard — catch "based-on / merging-into the wrong mainline" (#465).
//
// Queries the git HOST LIVE for (a) the default branch and (b) whether a branch
// is protected, then verdicts a base/target branch. Never trusts a cached
// `.claude-project.md` value and never uses `git symbolic-ref origin/HEAD` — a
// stale cached default is exactly the failure this tool exists to catch.
//
// Adapter-dispatching shell, mirroring handlers/pr_create.ts: platform-specific
// work lives in the adapter (`resolveDefaultBranch`, `checkBranchProtected`,
// `prList`); this handler owns only the platform-agnostic verdict logic.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import { runArgv } from '../lib/shared/error-norm.js';

// Kahuna per-wave integration branches (e.g. `kahuna/854-flightdeck`). These
// are themselves protected, so the sandbox carve-out MUST be applied before the
// protected gate — otherwise every legitimate kahuna base would falsely warn.
const KAHUNA_SANDBOX = /^kahuna\/[0-9]+-/;

const inputSchema = z.object({
  role: z.enum(['base', 'target']),
  // Optional: the branch to verdict. Omitted `target` → the live default (a PR
  // that omits base targets the default); omitted `base` → inferred from the
  // current branch's open PR.
  branch: z.string().min(1).optional(),
  repo: repoOptionalSchema,
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/** Current branch via `git branch --show-current`; '' on failure/detached HEAD. */
function currentBranch(cwd: string): string {
  const r = runArgv(['git', 'branch', '--show-current'], cwd);
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

const branchGuardHandler: HandlerDef = {
  name: 'branch_guard',
  description:
    "Guard against basing on / merging into the wrong mainline. Queries the git host LIVE for the default branch and branch-protection status, then verdicts a base/target branch. Returns {verdict: 'pass'|'warn', reason, default_branch, checked_branch, is_protected, is_sandbox}. A protected branch that is neither the live default nor a kahuna/* sandbox → warn.",
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const cwd = projectDir();

    // Live default branch — required for the envelope AND the B===default
    // comparison. Never a cached value.
    const defRes = await adapter.resolveDefaultBranch({ repo: args.repo, cwd });
    if ('platform_unsupported' in defRes) {
      return envelope({ ok: false, error: `default-branch resolution unsupported: ${defRes.hint}` });
    }
    if (!defRes.ok) return envelope({ ok: false, error: defRes.error });
    const default_branch = defRes.data.default_branch;

    // -- Resolve B, the branch to verdict --------------------------------------
    let checked_branch: string;
    if (args.role === 'target') {
      // A PR that omits base targets the live default (passes trivially); an
      // explicit target is verdicted directly.
      checked_branch = args.branch ?? default_branch;
    } else {
      // role === 'base'. Prefer the authoritative signal — the open PR's base
      // for the current branch (reliable). `prList({head})` returns the base as
      // `.base`, so no dedicated adapter method is needed.
      const explicit = args.branch;
      if (explicit !== undefined) {
        checked_branch = explicit;
      } else {
        const cur = currentBranch(cwd);
        let prBase: string | null = null;
        if (cur.length > 0) {
          const listRes = await adapter.prList({ head: cur, state: 'open', limit: 1, repo: args.repo });
          if (!('platform_unsupported' in listRes) && listRes.ok && listRes.data.prs.length > 0) {
            prBase = listRes.data.prs[0].base;
          }
        }
        if (prBase === null) {
          // No open PR — the fork base cannot be reliably named pre-PR. Return a
          // deliberate PASS (never a spurious warn: a false warn here would block
          // every precheck). The /scp target guard catches a wrong target at
          // PR-creation time.
          return envelope({
            ok: true,
            verdict: 'pass',
            reason:
              cur.length > 0
                ? `No open PR for '${cur}'; the fork base cannot be reliably determined pre-PR — pass (the /scp target guard catches a wrong target at creation).`
                : 'Current branch could not be determined (detached HEAD?); base cannot be verified pre-PR — pass.',
            default_branch,
            checked_branch: cur,
            is_protected: false,
            is_sandbox: cur.length > 0 ? KAHUNA_SANDBOX.test(cur) : false,
          });
        }
        checked_branch = prBase;
      }
    }

    // -- Verdict (ORDER IS LOAD-BEARING) --------------------------------------
    const B = checked_branch;

    // (2) Sandbox carve-out — BEFORE the protected gate. Kahuna sandbox branches
    //     are legitimate integration bases/targets and are themselves protected,
    //     so applying the protected gate first would falsely warn.
    if (KAHUNA_SANDBOX.test(B)) {
      return envelope({
        ok: true,
        verdict: 'pass',
        reason: `Branch '${B}' is a kahuna/* sandbox integration branch — always a legitimate base/target.`,
        default_branch,
        checked_branch: B,
        // Kahuna sandbox branches are protected by policy; reported without a
        // live query because the sandbox carve-out short-circuits the gate.
        is_protected: true,
        is_sandbox: true,
      });
    }

    // (3) Protected gate — resolve is_protected LIVE from the host.
    const protRes = await adapter.checkBranchProtected({ branch: B, repo: args.repo, cwd });
    if ('platform_unsupported' in protRes) {
      return envelope({ ok: false, error: `protected-branch check unsupported: ${protRes.hint}` });
    }
    if (!protRes.ok) return envelope({ ok: false, error: protRes.error });
    const is_protected = protRes.data.protected;

    if (!is_protected) {
      return envelope({
        ok: true,
        verdict: 'pass',
        reason: `Branch '${B}' is not a protected branch — no mainline-guard opinion (feature→feature / stacked branches are legitimate).`,
        default_branch,
        checked_branch: B,
        is_protected: false,
        is_sandbox: false,
      });
    }

    // (4) Protected AND the live default → pass.
    if (B === default_branch) {
      return envelope({
        ok: true,
        verdict: 'pass',
        reason: `Branch '${B}' is the live default branch.`,
        default_branch,
        checked_branch: B,
        is_protected: true,
        is_sandbox: false,
      });
    }

    // (5) Protected, non-default, non-sandbox → warn.
    return envelope({
      ok: true,
      verdict: 'warn',
      reason: `Branch '${B}' is a protected branch but not the live default '${default_branch}' and not a kahuna/* sandbox — likely a stale or renamed base/target. Confirm before proceeding.`,
      default_branch,
      checked_branch: B,
      is_protected: true,
      is_sandbox: false,
    });
  },
};

export default branchGuardHandler;
