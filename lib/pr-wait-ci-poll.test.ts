import { describe, test, expect } from 'bun:test';
import { remainingWaitSec } from './pr-wait-ci-poll.ts';

// #587: the adapters hand the poll loop whatever the settle window left of the
// call's budget, so the budget bounds the whole call and not just the loop.
describe('remainingWaitSec', () => {
  test('no budget stays no budget', () => {
    expect(remainingWaitSec(undefined, 45_000)).toBeUndefined();
  });

  test('subtracts whole seconds spent', () => {
    expect(remainingWaitSec(1500, 45_000)).toBe(1455);
    expect(remainingWaitSec(1500, 45_999)).toBe(1455);
  });

  test('an overspent budget is zero, never negative', () => {
    expect(remainingWaitSec(10, 45_000)).toBe(0);
  });
});
