/**
 * `glab api` reports HTTP errors on STDOUT with exit 0 (#502).
 *
 * So neither of execGlab's guards fired: not a non-zero exit, not empty output.
 * The typed wrapper JSON.parsed the error body into its expected shape, every
 * field came back `undefined`, and the handler emitted a confident `ok: true`
 * envelope full of falsy data.
 *
 * That is the most dangerous shape a validation tool has — a false negative that
 * reads as an authoritative answer. `spec_validate_structure` reported a
 * perfectly valid issue as missing all three required sections, with `ok: true`.
 * The tool did not fail; it answered, wrongly, and nothing downstream could tell.
 *
 * The detector is deliberately NARROW. Over-matching would turn real payloads
 * into errors, which is the same class of damage pointed the other way.
 */

import { describe, expect, test } from 'bun:test';
import { detectGlabApiError, execGlab } from './gitlab-api.js';

describe('GitLab error bodies are detected (#502)', () => {
  test('the reported shape — 404 on stdout with exit 0', () => {
    expect(detectGlabApiError('{"message":"404 Project Not Found"}')).toBe(
      '404 Project Not Found',
    );
  });

  test('403 and other message-carrying errors', () => {
    expect(detectGlabApiError('{"message":"403 Forbidden"}')).toBe('403 Forbidden');
  });

  test('the `error` carrier is recognised too', () => {
    expect(detectGlabApiError('{"error":"insufficient_scope"}')).toBe('insufficient_scope');
  });

  test('a non-string message is rendered, not dropped', () => {
    // GitLab returns per-field validation errors as an object or array; losing
    // them would replace one silent failure with a quieter one.
    const out = detectGlabApiError('{"message":{"title":["can\'t be blank"]}}');
    expect(out).toContain('title');
    expect(out).toContain("can't be blank");
  });
});

describe('real payloads are NOT mistaken for errors', () => {
  test('an issue carrying a `message`-like payload passes through', () => {
    // A real resource always carries identifying fields; an error body does not.
    expect(
      detectGlabApiError('{"iid":42,"title":"x","message":"a commit message"}'),
    ).toBeUndefined();
  });

  test('a commit — `message` is its legitimate content', () => {
    expect(
      detectGlabApiError('{"id":"abc123","sha":"abc123","message":"fix: thing"}'),
    ).toBeUndefined();
  });

  test('an empty collection is a legitimate answer, not an error', () => {
    expect(detectGlabApiError('[]')).toBeUndefined();
    expect(detectGlabApiError('{}')).toBeUndefined();
  });

  test('an array of resources passes through', () => {
    expect(detectGlabApiError('[{"iid":1},{"iid":2}]')).toBeUndefined();
  });

  test('non-JSON output is not our business', () => {
    expect(detectGlabApiError('some plain text')).toBeUndefined();
    expect(detectGlabApiError('')).toBeUndefined();
  });

  test('null and scalars do not throw', () => {
    expect(detectGlabApiError('null')).toBeUndefined();
    expect(detectGlabApiError('42')).toBeUndefined();
    expect(detectGlabApiError('"a string"')).toBeUndefined();
  });
});

describe('execGlab CONSULTS the detector (#502)', () => {
  // The detector being correct is not the same claim as execGlab using it — a
  // mutation disabling the call survived a suite that only tested the pure
  // function.
  //
  // Driven in a SUBPROCESS. execGlab calls execSync, and this repo has known
  // cross-file `mock.module` leakage (#456): run in-process, these pass alone
  // and fail under the full suite because execSync is mocked by another file.
  // A fresh `bun -e` gets a clean module registry, so the real path runs.
  function inFreshProcess(body: string): { ok: boolean; out: string } {
    const src = `
      import { execGlab } from '${import.meta.dir}/gitlab-api.ts';
      try { ${body} } catch (e) { console.log('THREW:' + String(e)); process.exit(0); }
    `;
    const proc = Bun.spawnSync(['bun', '-e', src]);
    return {
      ok: proc.exitCode === 0,
      out: proc.stdout.toString() + proc.stderr.toString(),
    };
  }

  test('an error body on stdout with exit 0 THROWS instead of returning', () => {
    const r = inFreshProcess(
      `execGlab("printf '%s' '{\\"message\\":\\"404 Project Not Found\\"}'"); console.log('NO_THROW');`,
    );
    expect(r.out).toContain('THREW:');
    expect(r.out).toContain('glab API error');
    expect(r.out).not.toContain('NO_THROW');
  });

  test('the thrown message carries the API error text', () => {
    const r = inFreshProcess(
      `execGlab("printf '%s' '{\\"message\\":\\"403 Forbidden\\"}'");`,
    );
    expect(r.out).toContain('403 Forbidden');
  });

  test('a real payload is returned unchanged', () => {
    const r = inFreshProcess(
      `const o = execGlab("printf '%s' '{\\"iid\\":42}'"); console.log('IID:' + JSON.parse(o).iid);`,
    );
    expect(r.out).toContain('IID:42');
    expect(r.out).not.toContain('THREW:');
  });

  test('an empty collection still succeeds — it is a legitimate answer', () => {
    const r = inFreshProcess(
      `console.log('LEN:' + JSON.parse(execGlab("printf '%s' '[]'")).length);`,
    );
    expect(r.out).toContain('LEN:0');
  });

  test('genuinely empty output still throws (the #382 guard is intact)', () => {
    const r = inFreshProcess(`execGlab("printf '%s' ''");`);
    expect(r.out).toContain('empty output');
  });

  test('a non-zero exit still throws (the original guard is intact)', () => {
    const r = inFreshProcess(`execGlab("sh -c 'exit 3'");`);
    expect(r.out).toContain('glab failed');
  });
});
