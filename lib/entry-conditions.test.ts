import { describe, test, expect } from 'bun:test';
import {
  describeHolds,
  evaluateWaveGate,
  isCrossPlanRef,
  MALFORMED_EC,
  parseEcStateComments,
  syncEntryConditions,
  type EcComment,
  type EntryConditions,
} from './entry-conditions.ts';

// #613. Every refusal test is paired with a positive control: the same input
// with the hold removed must NOT refuse, so a gate that always refuses fails.

const c = (body: string, created_at: string, url?: string): EcComment => ({
  body,
  created_at,
  url,
  trusted: true,
});

describe('parseEcStateComments', () => {
  test('ec_sync_latest_comment_wins — later comment overrides earlier, per EC', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] met https://x/1', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-2] met', '2026-10-02T00:00:00Z'),
      c('[ec-state EC-1] reclosed — rolled back', '2026-10-03T00:00:00Z'),
    ]);
    expect(r.latest['EC-1']).toEqual({
      status: 'reclosed',
      evidence: 'rolled back',
      updated_at: '2026-10-03T00:00:00Z',
    });
    expect(r.latest['EC-2'].status).toBe('met');
    expect(r.malformed).toEqual([]);
  });

  test('orders by created_at, not by input order', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] unmet', '2026-10-05T00:00:00Z'),
      c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('unmet');
  });

  test('later line in one comment wins; several ECs per comment', () => {
    const r = parseEcStateComments([
      c('notes\n[ec-state EC-1] met\n[ec-state EC-2] unmet\n[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('unmet');
    expect(r.latest['EC-2'].status).toBe('unmet');
  });

  test('id and status are case-insensitive; id normalizes to EC-n', () => {
    const r = parseEcStateComments([c('[EC-STATE ec-7] MET', '2026-10-01T00:00:00Z')]);
    expect(r.latest['EC-7'].status).toBe('met');
  });

  test('ec_missing_reads_unmet — an unknown status records the EC as unmet and is reported', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-1] mett', '2026-10-02T00:00:00Z'),
    ]);
    // A garbled update must not let the earlier `met` stand.
    expect(r.latest['EC-1'].status).toBe('unmet');
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0].reason).toContain('unknown status');
  });

  test('positive control — a well-formed later met is met', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-1] met', '2026-10-02T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('met');
  });

  test('a line with no readable EC id is reported and attaches to nothing', () => {
    const r = parseEcStateComments([c('[ec-state] met\n[ec-state foo] met', '2026-10-01T00:00:00Z')]);
    expect(Object.keys(r.latest)).toEqual([]);
    expect(r.malformed).toHaveLength(2);
  });

  test('ec_unreadable_id_reholds — an unreadable later line does not let an earlier met stand', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] met\n[ec-state EC-2] met', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-x1] reclosed', '2026-10-02T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('unmet');
    expect(r.latest['EC-2'].status).toBe('unmet');
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0].reason).toContain('no EC id');
  });

  test('positive control — a well-formed met after an unreadable line is met', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-x1] reclosed', '2026-10-02T00:00:00Z'),
      c('[ec-state EC-1] met', '2026-10-03T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('met');
  });

  test('ec_id_typos_parse — EC1, EC 1 and a space before the bracket all read as EC-1', () => {
    for (const id of ['EC1', 'EC 1', 'EC-1 ', 'ec1']) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
        c(`[ec-state ${id}] reclosed`, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('reclosed');
      expect(r.malformed).toEqual([]);
    }
  });

  test('ec_markdown_wrapped — a bulleted or bold state line is read', () => {
    for (const body of ['- [ec-state EC-1] reclosed', '* [ec-state EC-1] reclosed', '**[ec-state EC-1] reclosed**', '- **[ec-state EC-1] reclosed**']) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('reclosed');
    }
  });

  test('ec_markdown_wrapped — a numbered, code-span or italic state line is read', () => {
    for (const body of ['1. [ec-state EC-1] reclosed', '2) [ec-state EC-1] reclosed', '`[ec-state EC-1] reclosed`', '*[ec-state EC-1] reclosed*', '_[ec-state EC-1] reclosed_']) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('reclosed');
    }
  });

  test('ec_padded_id — EC-01 is EC-1', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-01] reclosed', '2026-10-02T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('reclosed');
    expect(r.latest['EC-01']).toBeUndefined();
  });

  test('positive control — a bold status with evidence after it is met, not a garbled status', () => {
    const r = parseEcStateComments([c('- **[ec-state EC-1] met** — https://e', '2026-10-01T00:00:00Z')]);
    expect(r.latest['EC-1'].status).toBe('met');
    expect(r.latest['EC-1'].evidence).toBe('https://e');
    expect(r.malformed).toEqual([]);
  });

  test('a quoted format template is reported and holds nothing back', () => {
    for (const body of ['[ec-state EC-<n>] met|unmet|reclosed', '- `[ec-state EC-n] met`']) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('met');
      expect(r.malformed).toHaveLength(1);
      expect(r.malformed[0].reason).toContain('template');
    }
  });

  test('positive control — a sentence that mentions a state line is not one', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
      c('Once it ships, post `[ec-state EC-1] met` here.', '2026-10-02T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('unmet');
  });

  test('ec_met_only_from_a_state_comment — a met in any other comment does not release', () => {
    for (const body of [
      // An instruction with the line in a code span.
      'When it ships, post:\n\n`[ec-state EC-1] met — <link to release>`',
      // ...in a fenced block, a nested fence, or a mismatched one.
      'When it ships, post:\n```\n[ec-state EC-1] met\n```',
      '````\n```\n[ec-state EC-1] met\n```\n````',
      '~~~\n```\n[ec-state EC-1] met\n```\n~~~',
      // ...a code span hard-wrapped open on the line before.
      'When it ships, post `\n[ec-state EC-1] met — <link>`',
      // ...an indented code block.
      'Post this:\n\n    [ec-state EC-1] met',
      // ...or a bare line under prose.
      'EC-1 is done:\n[ec-state EC-1] met',
    ]) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('unmet');
      expect(r.malformed.map((m) => m.reason).join('\n')).toContain('a met counts only in a comment of bare state lines');
    }
  });

  test('positive control — a state comment releases, wrapped or not, several ECs at once', () => {
    for (const body of ['[ec-state EC-1] met — https://e', '- [ec-state EC-1] met\n- [ec-state EC-2] met', '1. **[ec-state EC-1] met** — https://e\n\n2. [ec-state EC-2] met']) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] unmet\n[ec-state EC-2] unmet', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('met');
    }
  });

  test('ec_met_conditional_or_placeholder — a met whose evidence is a condition or a placeholder does not release', () => {
    for (const body of [
      '- [ec-state EC-1] met when vendor API v3 is GA',
      '[ec-state EC-1] met — once security signs off',
      '[ec-state EC-1] met — <link to release>',
    ]) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('unmet');
      expect(r.malformed[0].reason).toContain('condition or a placeholder');
    }
  });

  test('positive control — factual evidence, a ~user URL included, releases', () => {
    for (const body of ['[ec-state EC-1] met — https://git.sr.ht/~user/repo/refs/v3', '[ec-state EC-1] met shipped in v2.3', '[ec-state EC-1] met']) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('met');
    }
  });

  test('a tightening line holds from any comment: prose, code span or fenced block', () => {
    for (const body of ['Broke again.\n[ec-state EC-1] reclosed', '`[ec-state EC-1] reclosed`', '```\n[ec-state EC-1] reclosed\n```', '```[ec-state EC-1] reclosed```']) {
      const r = parseEcStateComments([
        c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
        c(body, '2026-10-02T00:00:00Z'),
      ]);
      expect(r.latest['EC-1'].status).toBe('reclosed');
    }
  });

  test('ec_filled_template_slot — EC-<3> is EC-3, not the template', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-3] met', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-<3>] reclosed', '2026-10-02T00:00:00Z'),
    ]);
    expect(r.latest['EC-3'].status).toBe('reclosed');
    expect(r.malformed).toEqual([]);
  });

  test('positive control — a quoted state line is not a state update', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
      c('> [ec-state EC-1] reclosed', '2026-10-02T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('met');
    expect(r.malformed).toEqual([]);
  });

  test('ordinary prose mentioning ec-state is ignored', () => {
    const r = parseEcStateComments([c('we will post an ec-state line later', '2026-10-01T00:00:00Z')]);
    expect(r.latest).toEqual({});
    expect(r.malformed).toEqual([]);
  });

  test('evidence falls back to the comment url', () => {
    const r = parseEcStateComments([c('[ec-state EC-1] met', '2026-10-01T00:00:00Z', 'https://c/1')]);
    expect(r.latest['EC-1'].evidence).toBe('https://c/1');
  });
});

describe('parseEcStateComments — comment trust', () => {
  test('ec_untrusted_ignored — an untrusted met does not release, and is reported', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
      { body: '[ec-state EC-1] met', created_at: '2026-10-02T00:00:00Z', author: 'drive-by', trusted: false },
    ]);
    expect(r.latest['EC-1'].status).toBe('unmet');
    expect(r.untrusted).toEqual([
      { line: '[ec-state EC-1] met', author: 'drive-by', created_at: '2026-10-02T00:00:00Z', url: undefined },
    ]);
  });

  test('an untrusted unmet or reclosed cannot hold a met EC either', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] met', '2026-10-01T00:00:00Z'),
      { body: '[ec-state EC-1] reclosed', created_at: '2026-10-02T00:00:00Z', trusted: false },
    ]);
    expect(r.latest['EC-1'].status).toBe('met');
    expect(r.untrusted).toHaveLength(1);
  });

  test('a comment with no trust flag at all is untrusted', () => {
    const r = parseEcStateComments([{ body: '[ec-state EC-1] met', created_at: '2026-10-02T00:00:00Z' }]);
    expect(r.latest).toEqual({});
    expect(r.untrusted[0].author).toBeNull();
  });

  test('positive control — the same met from a trusted author is applied', () => {
    const r = parseEcStateComments([
      c('[ec-state EC-1] unmet', '2026-10-01T00:00:00Z'),
      c('[ec-state EC-1] met', '2026-10-02T00:00:00Z'),
    ]);
    expect(r.latest['EC-1'].status).toBe('met');
    expect(r.untrusted).toEqual([]);
  });
});

describe('syncEntryConditions', () => {
  const declared: EntryConditions = {
    'EC-1': { status: 'unmet', gates: 'start' },
    'EC-2': { status: 'met', gates: 'delivery' },
  };

  test('declared EC with no comment is written unmet, and reported', () => {
    const r = syncEntryConditions(declared, { latest: {}, malformed: [], untrusted: [] });
    expect(r.entry_conditions['EC-1'].status).toBe('unmet');
    // A stale stored `met` with no comment behind it does not survive a sync.
    expect(r.entry_conditions['EC-2'].status).toBe('unmet');
    expect(r.no_comment).toEqual(['EC-1', 'EC-2']);
    expect(r.changed).toEqual([{ ec: 'EC-2', from: 'met', to: 'unmet' }]);
  });

  test('keeps declared gates; an unknown gates value becomes start', () => {
    const r = syncEntryConditions(
      { 'EC-1': { gates: 'delivery' }, 'EC-2': { gates: 'whenever' } },
      { latest: {}, malformed: [], untrusted: [] },
    );
    expect(r.entry_conditions['EC-1'].gates).toBe('delivery');
    expect(r.entry_conditions['EC-2'].gates).toBe('start');
  });

  test('ECs only seen in comments are reported, not invented', () => {
    const r = syncEntryConditions(declared, {
      latest: { 'EC-9': { status: 'met', evidence: '', updated_at: 't' } },
      malformed: [], untrusted: [],
    });
    expect(r.entry_conditions['EC-9']).toBeUndefined();
    expect(r.undeclared_in_comments).toEqual(['EC-9']);
  });

  test('a comment state is written with its evidence and time', () => {
    const r = syncEntryConditions(declared, {
      latest: { 'EC-1': { status: 'met', evidence: 'https://e', updated_at: '2026-10-09T00:00:00Z' } },
      malformed: [], untrusted: [],
    });
    expect(r.entry_conditions['EC-1']).toEqual({
      status: 'met',
      gates: 'start',
      evidence: 'https://e',
      updated_at: '2026-10-09T00:00:00Z',
    });
  });
});

describe('isCrossPlanRef', () => {
  test('qualified <plan>#<n> is cross-plan', () => {
    expect(isCrossPlanRef('612#4')).toBe(true);
    expect(isCrossPlanRef('platform-plan#12')).toBe(true);
  });
  test('positive control — today\'s ref shapes are not cross-plan', () => {
    expect(isCrossPlanRef('#4')).toBe(false);
    expect(isCrossPlanRef('Wave-Engineering/mcp-server-sdlc#4')).toBe(false);
    expect(isCrossPlanRef('group/sub/project#4')).toBe(false);
    expect(isCrossPlanRef(4)).toBe(false);
    expect(isCrossPlanRef('w2')).toBe(false);
  });
});

describe('EC id spellings', () => {
  test('ec_padded_declared_id — a declared EC-01 takes a posted EC-1', () => {
    const parsed = parseEcStateComments([c('[ec-state EC-1] met', '2026-10-01T00:00:00Z')]);
    const r = syncEntryConditions({ 'EC-01': { status: 'unmet', gates: 'start' } }, parsed);
    expect(r.entry_conditions['EC-01'].status).toBe('met');
    expect(r.no_comment).toEqual([]);
    expect(r.undeclared_in_comments).toEqual([]);
  });

  test('ec_padded_story_id — a story naming EC-01 is gated by a declared EC-1', () => {
    expect(evaluateWaveGate({ 'EC-1': { status: 'unmet', gates: 'start' } }, [{ number: 10, ec: ['EC-01'] }]).held).toBe(true);
    // Positive control: the same EC met releases it.
    expect(evaluateWaveGate({ 'EC-1': { status: 'met', gates: 'start' } }, [{ number: 10, ec: ['EC-01'] }]).held).toBe(false);
  });

  test('two declared spellings of one id: a not-met one holds whichever order they come in', () => {
    const both = (a: string, b: string) =>
      evaluateWaveGate(
        { [a]: { status: 'met', gates: 'start' }, [b]: { status: 'unmet', gates: 'start' } },
        [{ number: 10, ec: ['EC-1'] }],
      ).held;
    expect(both('EC-1', 'EC-01')).toBe(true);
    expect(both('EC-01', 'EC-1')).toBe(true);
  });

  test('two declared spellings of one id: a start gate on either holds the start, whichever order', () => {
    const gate = (first: [string, string], second: [string, string]) =>
      evaluateWaveGate(
        { [first[0]]: { status: 'unmet', gates: first[1] }, [second[0]]: { status: 'unmet', gates: second[1] } },
        [{ number: 10, ec: ['EC-1'] }],
      );
    expect(gate(['EC-01', 'delivery'], ['EC-1', 'start']).held).toBe(true);
    expect(gate(['EC-1', 'start'], ['EC-01', 'delivery']).held).toBe(true);
    // Positive control: both delivery lets the wave start, with the completion hold reported.
    const both = gate(['EC-01', 'delivery'], ['EC-1', 'delivery']);
    expect(both.held).toBe(false);
    expect(both.delivery).toHaveLength(1);
  });
});

describe('evaluateWaveGate', () => {
  test('ec_unmet_refuses_start — an unmet start EC holds the wave', () => {
    const g = evaluateWaveGate({ 'EC-1': { status: 'unmet', gates: 'start' } }, [
      { number: 10, ec: ['EC-1'] },
      { number: 11 },
    ]);
    expect(g.held).toBe(true);
    expect(g.start).toEqual([{ ec: 'EC-1', status: 'unmet', gates: 'start', issues: [10] }]);
  });

  test('positive control — the same EC met does not hold', () => {
    const g = evaluateWaveGate({ 'EC-1': { status: 'met', gates: 'start' } }, [
      { number: 10, ec: ['EC-1'] },
    ]);
    expect(g.held).toBe(false);
    expect(g.start).toEqual([]);
  });

  test('ec_missing_reads_unmet — an undeclared EC, or one with no status, holds', () => {
    const g = evaluateWaveGate({ 'EC-2': { gates: 'start' } }, [
      { number: 10, ec: ['EC-1'] },
      { number: 11, ec: ['EC-2'] },
    ]);
    expect(g.held).toBe(true);
    expect(g.start.map((h) => [h.ec, h.status])).toEqual([
      ['EC-1', 'undeclared'],
      ['EC-2', 'unmet'],
    ]);
  });

  test('ec_delivery_allows_start — a delivery EC holds only completion', () => {
    const g = evaluateWaveGate({ 'EC-1': { status: 'unmet', gates: 'delivery' } }, [
      { number: 10, ec: ['EC-1'] },
    ]);
    expect(g.held).toBe(false);
    expect(g.delivery).toEqual([{ ec: 'EC-1', status: 'unmet', gates: 'delivery', issues: [10] }]);
  });

  test('positive control — a met delivery EC holds nothing', () => {
    const g = evaluateWaveGate({ 'EC-1': { status: 'met', gates: 'delivery' } }, [
      { number: 10, ec: ['EC-1'] },
    ]);
    expect(g.delivery).toEqual([]);
  });

  test('ec_reclosed_reholds — reclosed holds as unmet does', () => {
    const g = evaluateWaveGate({ 'EC-1': { status: 'reclosed', gates: 'start' } }, [
      { number: 10, ec: ['EC-1'] },
    ]);
    expect(g.held).toBe(true);
    expect(g.start[0].status).toBe('reclosed');
  });

  test('xplan_dep_unresolved_refuses — a qualified cross-plan ref holds', () => {
    const g = evaluateWaveGate(undefined, [{ number: 10, depends_on: ['612#4', '#3'] }]);
    expect(g.held).toBe(true);
    expect(g.depends_on).toEqual([{ ref: '612#4', issue: 10, reason: 'cross_plan_unresolved' }]);
  });

  test('positive control — same-plan refs do not hold', () => {
    const g = evaluateWaveGate(undefined, [{ number: 10, depends_on: ['#3', 'o/r#4', 5] }]);
    expect(g.held).toBe(false);
  });

  test('ec_malformed_holds — an `ec` that is not an array of EC ids holds the wave', () => {
    const decl = { 'EC-1': { status: 'unmet', gates: 'start' } };
    for (const ec of ['EC-1', [1], [{ id: 'EC-1' }], ['EC-1', ''], {}]) {
      const g = evaluateWaveGate(decl, [{ number: 10, ec }]);
      expect(g.held).toBe(true);
      expect(g.start).toEqual([{ ec: MALFORMED_EC, status: 'malformed', gates: 'start', issues: [10] }]);
    }
  });

  test('positive control — an absent, null or empty `ec` names no EC and holds nothing', () => {
    for (const ec of [undefined, null, []]) {
      expect(evaluateWaveGate(undefined, [{ number: 10, ec }]).held).toBe(false);
    }
  });

  test('a malformed `ec` holds even when the plan declares no ECs at all', () => {
    const g = evaluateWaveGate(undefined, [{ number: 10, ec: 'EC-1' }, { number: 11, ec: 7 }]);
    expect(g.start).toEqual([{ ec: MALFORMED_EC, status: 'malformed', gates: 'start', issues: [10, 11] }]);
  });

  test('dep_malformed_holds — a scalar `depends_on`, or an unreadable entry, holds', () => {
    const scalar = evaluateWaveGate(undefined, [{ number: 10, depends_on: '612#4' }]);
    expect(scalar.held).toBe(true);
    expect(scalar.depends_on).toEqual([{ ref: '"612#4"', issue: 10, reason: 'malformed' }]);

    const entries = evaluateWaveGate(undefined, [{ number: 11, depends_on: ['#3', { ref: '612#4' }, ''] }]);
    expect(entries.held).toBe(true);
    expect(entries.depends_on.map((d) => d.reason)).toEqual(['malformed', 'malformed']);
  });

  test('positive control — absent or null `depends_on` holds nothing', () => {
    for (const depends_on of [undefined, null, []]) {
      expect(evaluateWaveGate(undefined, [{ number: 10, depends_on }]).held).toBe(false);
    }
  });

  test('describeHolds names a malformed `ec` and a malformed dep by issue', () => {
    const msg = describeHolds('w1', evaluateWaveGate(undefined, [{ number: 10, ec: 'EC-1', depends_on: 5.5 }]));
    expect(msg).toContain('#10: `ec` is not an array of EC ids');
    expect(msg).toContain('#10 has an unreadable depends_on entry 5.5');
  });

  test('one EC on several stories is one hold naming every story', () => {
    const g = evaluateWaveGate({ 'EC-1': { status: 'unmet', gates: 'start' } }, [
      { number: 10, ec: ['EC-1'] },
      { number: 11, ec: ['EC-1', 'EC-1'] },
    ]);
    expect(g.start).toEqual([{ ec: 'EC-1', status: 'unmet', gates: 'start', issues: [10, 11] }]);
  });

  test('legacy_plan_unchanged — no ECs and no qualified refs holds nothing', () => {
    const g = evaluateWaveGate(undefined, [{ number: 10 }, { number: 11, depends_on: ['#10'] }]);
    expect(g).toEqual({ start: [], delivery: [], depends_on: [], held: false });
  });

  test('describeHolds names each EC with its state and each ref', () => {
    const g = evaluateWaveGate({ 'EC-1': { status: 'unmet', gates: 'start' } }, [
      { number: 10, ec: ['EC-1'], depends_on: ['612#4'] },
    ]);
    const msg = describeHolds('w2', g);
    expect(msg).toContain('wave w2 is held');
    expect(msg).toContain('EC-1 is unmet (start) for #10');
    expect(msg).toContain('612#4');
  });
});
