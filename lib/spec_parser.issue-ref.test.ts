import { describe, test, expect } from 'bun:test';
import { parseIssueRef, resolveIssueTarget } from './spec_parser.ts';

// #615: the issue a write lands on. Each refusal is paired with a positive
// control, so a resolver that always refuses fails.

describe('parseIssueRef', () => {
  test('qualified refs keep their full path, nested groups included', () => {
    expect(parseIssueRef('org/repo#6')).toEqual({ owner: 'org', repo: 'repo', number: 6 });
    expect(parseIssueRef('g/sub/proj#6')).toEqual({ owner: 'g/sub', repo: 'proj', number: 6 });
  });

  test('bare refs have no project', () => {
    expect(parseIssueRef('#6')).toEqual({ owner: null, repo: null, number: 6 });
    expect(parseIssueRef('6')).toEqual({ owner: null, repo: null, number: 6 });
  });

  test('anything else is null', () => {
    expect(parseIssueRef('not-an-issue')).toBeNull();
    expect(parseIssueRef('org/repo#')).toBeNull();
  });
});

describe('resolveIssueTarget', () => {
  test('a qualified ref targets its own project', () => {
    expect(resolveIssueTarget('g/sub/proj#6', undefined)).toEqual({ ok: true, number: 6, repo: 'g/sub/proj' });
  });

  test('ambiguous_issue_ref — a repo that names another project refuses', () => {
    const r = resolveIssueTarget('g/sub/other#6', 'g/sub/proj');
    expect(r).toMatchObject({ ok: false, code: 'ambiguous_issue_ref' });
  });

  test('positive control — a repo equal to the ref\'s path resolves', () => {
    expect(resolveIssueTarget('g/sub/proj#6', 'g/sub/proj')).toEqual({ ok: true, number: 6, repo: 'g/sub/proj' });
  });

  test('a bare ref keeps repo when given, and no repo when not', () => {
    expect(resolveIssueTarget('#6', 'org/repo')).toEqual({ ok: true, number: 6, repo: 'org/repo' });
    expect(resolveIssueTarget('#6', undefined)).toEqual({ ok: true, number: 6 });
  });

  test('an unparseable ref is invalid_issue_ref', () => {
    expect(resolveIssueTarget('nope', undefined)).toMatchObject({ ok: false, code: 'invalid_issue_ref' });
  });
});
