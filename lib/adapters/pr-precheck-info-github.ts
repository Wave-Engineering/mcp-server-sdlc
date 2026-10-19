/**
 * GitHub `prPrecheckInfo` adapter (#592): one snapshot of a PR's head SHA,
 * refs, body and draft state, from a single `gh pr view --json`. Fails closed.
 */

import { execSync } from 'child_process';
import type { AdapterResult, PrPrecheckInfo, PrPrecheckInfoArgs } from './types.js';
import { viewPrGithub } from './precheck-shared-github.js';

export async function prPrecheckInfoGithub(
  args: PrPrecheckInfoArgs,
): Promise<AdapterResult<PrPrecheckInfo>> {
  try {
    const view = viewPrGithub(args.number, args.repo, 'pr_info_read_failed');
    if (!view.ok) return view;
    const { node_id: _nodeId, ...info } = view.data;
    return { ok: true, data: info };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

void execSync;
