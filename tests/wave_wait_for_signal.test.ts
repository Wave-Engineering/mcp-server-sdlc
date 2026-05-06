import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';

import handler, {
  __runWithDeps,
  matchSignal,
  POLL_INTERVAL_SEC,
} from '../handlers/wave_wait_for_signal.ts';

// File operations use Bun.write/Bun.spawnSync('rm') instead of node:fs to
// avoid leakage from `mock.module('fs', ...)` calls in sibling test files
// (lesson_bun_native_apis.md).
async function makeTmpDir(prefix: string): Promise<string> {
  const path = `/tmp/${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  // Bun.write creates parent directories on demand; make a marker then
  // delete it, leaving the directory in place.
  await Bun.write(`${path}/.tmp-marker`, '');
  return path;
}

async function cleanupTmpDir(path: string): Promise<void> {
  Bun.spawnSync(['rm', '-rf', path]);
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_wait_for_signal handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_wait_for_signal');
    expect(typeof handler.execute).toBe('function');
    expect(handler.description).toContain('signal_path');
  });

  describe('schema validation', () => {
    test('rejects missing signal_path', async () => {
      const result = await handler.execute({});
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
    });

    test('rejects empty signal_path', async () => {
      const result = await handler.execute({ signal_path: '' });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
    });

    test('rejects non-positive timeout_sec', async () => {
      const result = await handler.execute({ signal_path: 'x', timeout_sec: 0 });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
    });

    test('rejects non-positive min_count', async () => {
      const result = await handler.execute({ signal_path: 'x', min_count: 0 });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(false);
    });

    test('applies defaults: timeout_sec=1800, min_count=1', async () => {
      // Uses __runWithDeps so we don't hit the real 1800s timeout. We
      // verify defaults indirectly: the loop returns immediately because
      // matchFn returns one path, and min_count default is 1.
      const result = await __runWithDeps(
        { signal_path: 'wavebus/x.done' },
        {
          matchFn: () => ['/tmp/x.done'],
          sleepFn: async () => {
            throw new Error('should not sleep on immediate match');
          },
          nowFn: () => 0,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.matched).toEqual(['/tmp/x.done']);
    });
  });

  describe('matchSignal — real filesystem', () => {
    let tmpDir: string;
    beforeEach(async () => {
      tmpDir = await makeTmpDir('wave-wait-test');
    });
    afterEach(async () => {
      await cleanupTmpDir(tmpDir);
    });

    test('literal path: returns [path] when file exists, [] otherwise', async () => {
      const filePath = join(tmpDir, 'flight-1.done');
      expect(matchSignal(filePath)).toEqual([]);
      await Bun.write(filePath, '');
      expect(matchSignal(filePath)).toEqual([filePath]);
    });

    test('glob pattern: returns sorted absolute paths of matching files', async () => {
      await Bun.write(join(tmpDir, 'flights', 'flight-2.done'), '');
      await Bun.write(join(tmpDir, 'flights', 'flight-1.done'), '');
      await Bun.write(join(tmpDir, 'flights', 'flight-3.pending'), '');

      const matches = matchSignal('flights/*.done', tmpDir);
      expect(matches).toHaveLength(2);
      expect(matches[0]).toContain('flight-1.done');
      expect(matches[1]).toContain('flight-2.done');
      // sorted
      expect(matches[0] < matches[1]).toBe(true);
    });

    test('glob pattern: returns [] when no matches', () => {
      const matches = matchSignal('nothing/*.done', tmpDir);
      expect(matches).toEqual([]);
    });
  });

  describe('polling loop (via __runWithDeps)', () => {
    test('test_wave_wait_for_signal_matches_immediately', async () => {
      let sleeps = 0;
      const result = await __runWithDeps(
        { signal_path: 'foo.done', timeout_sec: 100, min_count: 1 },
        {
          matchFn: () => ['/abs/foo.done'],
          sleepFn: async () => {
            sleeps += 1;
          },
          nowFn: () => 0,
        },
      );
      expect(result.ok).toBe(true);
      expect(result.matched).toEqual(['/abs/foo.done']);
      expect(result.elapsed_sec).toBe(0);
      expect(result.timed_out).toBeUndefined();
      expect(sleeps).toBe(0); // never slept — matched on first check
    });

    test('test_wave_wait_for_signal_polls_until_match', async () => {
      // Simulate: first 2 checks return 0 matches, third returns 2 matches
      // (>= min_count of 2). Verify it sleeps twice and returns matched.
      const matchSequence = [[], [], ['/a/1.done', '/a/2.done']];
      let checkCount = 0;
      const sleepDurationsMs: number[] = [];
      let virtualNow = 0;

      const result = await __runWithDeps(
        { signal_path: 'a/*.done', timeout_sec: 100, min_count: 2 },
        {
          matchFn: () => matchSequence[checkCount++] ?? [],
          sleepFn: async (ms) => {
            sleepDurationsMs.push(ms);
            virtualNow += ms;
          },
          nowFn: () => virtualNow,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.matched).toEqual(['/a/1.done', '/a/2.done']);
      expect(result.timed_out).toBeUndefined();
      expect(sleepDurationsMs).toEqual([
        POLL_INTERVAL_SEC * 1000,
        POLL_INTERVAL_SEC * 1000,
      ]);
      expect(checkCount).toBe(3);
      expect(result.elapsed_sec).toBe(POLL_INTERVAL_SEC * 2);
    });

    test('test_wave_wait_for_signal_times_out', async () => {
      // No matches ever. Verify timed_out=true, elapsed_sec === timeout_sec,
      // partial_matches is empty.
      let virtualNow = 0;
      const result = await __runWithDeps(
        { signal_path: 'never.done', timeout_sec: 30, min_count: 1 },
        {
          matchFn: () => [],
          sleepFn: async (ms) => {
            virtualNow += ms;
          },
          nowFn: () => virtualNow,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.timed_out).toBe(true);
      expect(result.elapsed_sec).toBe(30);
      expect(result.partial_matches).toEqual([]);
      expect(result.matched).toBeUndefined();
    });

    test('test_wave_wait_for_signal_partial_matches', async () => {
      // min_count=3, but only 2 files ever appear before timeout.
      // partial_matches should contain those 2 paths.
      let virtualNow = 0;
      let checkCount = 0;
      const matchSequence: string[][] = [
        [],
        ['/a/1.done'],
        ['/a/1.done', '/a/2.done'],
        ['/a/1.done', '/a/2.done'],
        ['/a/1.done', '/a/2.done'],
      ];
      const result = await __runWithDeps(
        { signal_path: 'a/*.done', timeout_sec: 20, min_count: 3 },
        {
          matchFn: () => matchSequence[Math.min(checkCount++, matchSequence.length - 1)],
          sleepFn: async (ms) => {
            virtualNow += ms;
          },
          nowFn: () => virtualNow,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.timed_out).toBe(true);
      expect(result.partial_matches).toEqual(['/a/1.done', '/a/2.done']);
      expect(result.elapsed_sec).toBe(20);
    });

    test('does NOT return early when match count is below min_count', async () => {
      // matchFn returns 2 matches, but min_count=5. Must wait for timeout.
      let virtualNow = 0;
      const result = await __runWithDeps(
        { signal_path: 'a/*.done', timeout_sec: 25, min_count: 5 },
        {
          matchFn: () => ['/a/1.done', '/a/2.done'],
          sleepFn: async (ms) => {
            virtualNow += ms;
          },
          nowFn: () => virtualNow,
        },
      );
      expect(result.timed_out).toBe(true);
      expect(result.partial_matches).toEqual(['/a/1.done', '/a/2.done']);
    });
  });

  describe('execute (full handler entry point)', () => {
    let tmpDir: string;
    beforeEach(async () => {
      tmpDir = await makeTmpDir('wave-wait-exec');
    });
    afterEach(async () => {
      await cleanupTmpDir(tmpDir);
    });

    test('immediate match against real filesystem returns ok:true with matched paths', async () => {
      const sigPath = join(tmpDir, 'ready.done');
      await Bun.write(sigPath, '');

      const result = await handler.execute({
        signal_path: sigPath,
        timeout_sec: 10,
        min_count: 1,
      });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.matched).toEqual([sigPath]);
      expect(parsed.timed_out).toBeUndefined();
    });
  });
});
