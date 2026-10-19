/**
 * GitLab `prPrecheckInfo` adapter (#592): one snapshot of an MR's head SHA,
 * refs, description and draft state. Fails closed.
 */

import { execSync } from 'child_process';
import type { AdapterResult, PrPrecheckInfo, PrPrecheckInfoArgs } from './types.js';
import { viewMrGitlab } from './precheck-shared-gitlab.js';

export async function prPrecheckInfoGitlab(
  args: PrPrecheckInfoArgs,
): Promise<AdapterResult<PrPrecheckInfo>> {
  try {
    return viewMrGitlab(args.number, args.repo, 'pr_info_read_failed');
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

void execSync;
