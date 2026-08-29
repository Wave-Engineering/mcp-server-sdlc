// FIXTURE (#534): AdapterResult relay that DROPS `code` — the rule MUST flag it.
//
// Two properties the grep gate cannot see, both exercised here:
//   1. the result is NOT named `result` (it's `prResult`) — name-agnostic;
//   2. the ok:false envelope is spread across multiple lines — shape-agnostic.
//
// `.fixture.ts` (not `.test.ts`) so `bun test` never executes it; the oracle
// test points the checker at it explicitly.

import type { AdapterResult } from '../../../lib/adapters/types.ts';

declare function envelope(payload: unknown): unknown;
declare function callAdapter(): Promise<AdapterResult<{ id: number }>>;

export async function handler(): Promise<unknown> {
  const prResult = await callAdapter();
  if ('platform_unsupported' in prResult) {
    return envelope({ ok: true, platform_unsupported: true, hint: prResult.hint });
  }
  if (!prResult.ok) {
    return envelope({
      ok: false,
      error: prResult.error,
    });
  }
  return envelope({ ok: true, ...prResult.data });
}
