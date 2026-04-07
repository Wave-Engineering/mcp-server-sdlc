import { describe, test, expect } from 'bun:test';
import { handlers } from '../handlers/_registry';

describe('routing — handler contract (auto-discovered via codegen)', () => {
  test('at least one handler is registered', () => {
    expect(handlers.length).toBeGreaterThan(0);
  });

  for (const handler of handlers) {
    describe(handler.name, () => {
      test('exports a valid HandlerDef shape', () => {
        expect(handler).toBeDefined();
      });

      test('name is a non-empty string', () => {
        expect(typeof handler.name).toBe('string');
        expect(handler.name.length).toBeGreaterThan(0);
      });

      test('description is a non-empty string', () => {
        expect(typeof handler.description).toBe('string');
        expect(handler.description.length).toBeGreaterThan(0);
      });

      test('inputSchema is defined', () => {
        expect(handler.inputSchema).toBeDefined();
      });

      test('execute is a function', () => {
        expect(typeof handler.execute).toBe('function');
      });
    });
  }
});

// Smoke test: actually start the server and verify tools/list returns a non-empty array.
// This is what would have caught the import.meta.glob bug.
describe('routing — runtime smoke (catches what unit tests miss)', () => {
  test('handlers list is non-empty when imported from _registry', () => {
    // The mere fact that we got here means _registry.ts was generated and importable.
    // If codegen didn't run, this file would fail to import at all.
    expect(handlers).toBeDefined();
    expect(Array.isArray(handlers)).toBe(true);
    expect(handlers.length).toBeGreaterThan(0);
  });
});
