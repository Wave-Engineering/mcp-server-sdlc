// FIXTURE (#534): AdapterResult relays that PRESERVE `code` — the rule must PASS,
// with `code:` appearing either BEFORE or AFTER `error:`.

import type { AdapterResult } from '../../../lib/adapters/types.ts';

declare function envelope(payload: unknown): unknown;
declare function callAdapter(): Promise<AdapterResult<{ id: number }>>;

export async function codeAfterError(): Promise<unknown> {
  const result = await callAdapter();
  if ('platform_unsupported' in result) return envelope({ ok: true });
  if (!result.ok) return envelope({ ok: false, error: result.error, code: result.code });
  return envelope({ ok: true, ...result.data });
}

export async function codeBeforeError(): Promise<unknown> {
  const res = await callAdapter();
  if ('platform_unsupported' in res) return envelope({ ok: true });
  if (!res.ok) return envelope({ ok: false, code: res.code, error: res.error });
  return envelope({ ok: true, ...res.data });
}
