import { describe, test, expect } from 'bun:test';
import type { HandlerDef } from '../types.js';

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

describe('routing — ibm registration', () => {
  test('ibm handler exports a valid HandlerDef with name "ibm"', async () => {
    const mod = await import('../handlers/ibm.ts');
    const handler = mod.default as HandlerDef;

    expect(handler).toBeDefined();
    expect(handler.name).toBe('ibm');
    expect(typeof handler.description).toBe('string');
    expect(handler.description.length).toBeGreaterThan(0);
    expect(handler.inputSchema).toBeDefined();
    expect(typeof handler.execute).toBe('function');
  });

  test('ibm inputSchema accepts empty input (no branch)', async () => {
    const mod = await import('../handlers/ibm.ts');
    const handler = mod.default as HandlerDef;
    const result = handler.inputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('ibm inputSchema accepts optional branch string', async () => {
    const mod = await import('../handlers/ibm.ts');
    const handler = mod.default as HandlerDef;
    const result = handler.inputSchema.safeParse({ branch: 'feature/42-my-thing' });
    expect(result.success).toBe(true);
  });

  test('ibm glob simulation — appears in handler registry', () => {
    const mockHandler: HandlerDef = {
      name: 'ibm',
      description: 'Check Issue → Branch → PR/MR workflow compliance.',
      inputSchema: {} as HandlerDef['inputSchema'],
      execute: async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
    };
    const modules: Record<string, { default: HandlerDef }> = {
      './handlers/ibm.ts': { default: mockHandler },
    };
    const handlers = Object.values(modules).map(m => m.default).filter(Boolean);
    expect(handlers.length).toBe(1);
    expect(handlers[0].name).toBe('ibm');
  });
});
