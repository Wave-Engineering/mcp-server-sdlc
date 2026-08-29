// FIXTURE (#534): TRUE NEGATIVE — a LOCAL result type whose ok:false arm has NO
// `code` field (mirrors lib/wave-finalize.ts resolveArtifactsDir). Relaying it
// without `code:` is CORRECT, so the rule must NOT flag it.

declare function envelope(payload: unknown): unknown;

function resolveLocal(x: string): { ok: true; path: string } | { ok: false; error: string } {
  if (x.length > 0) return { ok: true, path: x };
  return { ok: false, error: 'empty' };
}

export function handler(x: string): unknown {
  const resolved = resolveLocal(x);
  if (!resolved.ok) return envelope({ ok: false, error: resolved.error });
  return envelope({ ok: true, path: resolved.path });
}
