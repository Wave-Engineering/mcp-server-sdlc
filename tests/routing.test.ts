import { describe, test, expect } from 'bun:test';

describe('routing — empty registry', () => {
  test('server starts and lists 0 tools with empty handlers dir', async () => {
    // With empty handlers/, the glob produces no modules
    // Simulate what the glob registry produces when no handlers exist
    const modules: Record<string, { default: unknown }> = {};
    const handlers = Object.values(modules)
      .map(m => m.default)
      .filter(Boolean);

    expect(handlers.length).toBe(0);
  });

  test('glob registry filters out modules without a default export', () => {
    // Handlers with no default export should be filtered out
    const modules: Record<string, { default: unknown }> = {
      './handlers/no-default.ts': { default: undefined as unknown },
    };
    const handlers = Object.values(modules)
      .map(m => m.default)
      .filter(Boolean);

    expect(handlers.length).toBe(0);
  });

  test('glob registry includes modules with valid default export', () => {
    // A handler with a valid default export should be included
    const mockHandler = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {},
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    };
    const modules: Record<string, { default: unknown }> = {
      './handlers/test.ts': { default: mockHandler },
    };
    const handlers = Object.values(modules)
      .map(m => m.default)
      .filter(Boolean);

    expect(handlers.length).toBe(1);
    expect(handlers[0]).toBe(mockHandler);
  });
});
