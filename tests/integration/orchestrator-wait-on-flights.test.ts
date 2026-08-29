/**
 * Integration test for wave_wait_for_signal — the canonical Orchestrator
 * scenario where the tool replaces an inline polling loop.
 *
 * Scenario: an Orchestrator dispatches three Flights, each writing a
 * `flight-N.done` artifact to a shared wavebus directory. The Orchestrator
 * calls wave_wait_for_signal with `min_count: 3` and waits. We verify the
 * tool returns once all three artifacts exist, with `matched` populated and
 * no `timed_out` flag.
 *
 * This is a real-filesystem test (no fs mocks). It uses Bun-native APIs
 * (Bun.write, Bun.spawnSync) instead of node:fs to stay immune to sibling
 * files' shared `fs` module mock (lib/test-support/mock-fs.ts) regardless of
 * load order (#456).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';

import handler from '../../handlers/wave_wait_for_signal.ts';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function makeTmpDir(prefix: string): Promise<string> {
  const path = `/tmp/${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await Bun.write(`${path}/.tmp-marker`, '');
  return path;
}

function cleanupTmpDir(path: string): void {
  Bun.spawnSync(['rm', '-rf', path]);
}

describe('orchestrator-wait-on-flights integration', () => {
  let waveDir: string;
  let flightsDir: string;

  beforeEach(async () => {
    waveDir = await makeTmpDir('orchestrator-wait');
    flightsDir = join(waveDir, 'flights');
    await Bun.write(`${flightsDir}/.keep`, '');
  });

  afterEach(() => {
    cleanupTmpDir(waveDir);
  });

  test('Orchestrator waits on Flight artifacts and returns matched paths', async () => {
    // Pre-stage all three artifacts so the tool returns on the first
    // immediate check (no real wall-clock 5s sleep). The polling-loop
    // semantics are exercised by the unit tests with mocked sleep.
    await Bun.write(join(flightsDir, 'flight-1.done'), '');
    await Bun.write(join(flightsDir, 'flight-2.done'), '');
    await Bun.write(join(flightsDir, 'flight-3.done'), '');

    const pattern = join(flightsDir, '*.done');
    const result = await handler.execute({
      signal_path: pattern,
      timeout_sec: 10,
      min_count: 3,
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.timed_out).toBeUndefined();
    expect(parsed.matched).toBeDefined();
    expect(parsed.matched).toHaveLength(3);
    expect(parsed.matched.sort()).toEqual([
      join(flightsDir, 'flight-1.done'),
      join(flightsDir, 'flight-2.done'),
      join(flightsDir, 'flight-3.done'),
    ]);
    // elapsed_sec ≤ 1 because all artifacts existed at call time.
    expect(parsed.elapsed_sec).toBeLessThanOrEqual(1);
  });

  test('partial pre-stage: caller can detect under-min via matched.length', async () => {
    // Real-filesystem variant: the immediate check returns < min_count, so
    // the loop would sleep. We verify the immediate-check classification
    // against a real glob without paying for the real 5s sleep by calling
    // the matchSignal helper directly here. End-to-end timeout/partial_matches
    // semantics are covered by the unit test suite with a mocked clock; this
    // test asserts the glob plumbing (real Bun.Glob against real files) is
    // wired correctly.
    const { matchSignal } = await import('../../handlers/wave_wait_for_signal.ts');
    await Bun.write(join(flightsDir, 'flight-1.done'), '');

    const pattern = join(flightsDir, '*.done');
    const matches = matchSignal(pattern);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(join(flightsDir, 'flight-1.done'));
  });
});
