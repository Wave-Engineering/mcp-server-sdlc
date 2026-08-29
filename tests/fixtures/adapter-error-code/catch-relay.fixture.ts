// FIXTURE (#534): TRUE NEGATIVE — a catch block relaying a thrown JS error via
// `err instanceof Error`. There is no `if (!X.ok)` here, so the rule must NOT
// flag it (it has no AdapterResult `code` to preserve in the first place).

declare function envelope(payload: unknown): unknown;
declare function doThing(): void;

export function handler(): unknown {
  try {
    doThing();
    return envelope({ ok: true });
  } catch (err) {
    return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
