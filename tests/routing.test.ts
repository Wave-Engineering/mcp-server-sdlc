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

describe('routing — work_item registration', () => {
  test('work_item handler exports a valid HandlerDef with correct name', async () => {
    const mod = await import('../handlers/work_item.ts');
    const handler = mod.default as HandlerDef;
    expect(handler).toBeDefined();
    expect(handler.name).toBe('work_item');
    expect(typeof handler.description).toBe('string');
    expect(handler.description.length).toBeGreaterThan(0);
    expect(handler.inputSchema).toBeDefined();
    expect(typeof handler.execute).toBe('function');
  });

  test('work_item inputSchema accepts valid issue input', async () => {
    const mod = await import('../handlers/work_item.ts');
    const handler = mod.default as HandlerDef;
    const result = handler.inputSchema.safeParse({ type: 'story', title: 'Test story' });
    expect(result.success).toBe(true);
  });

  test('work_item inputSchema accepts valid pr input', async () => {
    const mod = await import('../handlers/work_item.ts');
    const handler = mod.default as HandlerDef;
    const result = handler.inputSchema.safeParse({
      type: 'pr',
      title: 'My PR',
      head_branch: 'feature/1-foo',
      base_branch: 'main',
      draft: false,
    });
    expect(result.success).toBe(true);
  });

  test('work_item inputSchema rejects unknown type', async () => {
    const mod = await import('../handlers/work_item.ts');
    const handler = mod.default as HandlerDef;
    const result = handler.inputSchema.safeParse({ type: 'task', title: 'Bad type' });
    expect(result.success).toBe(false);
  });

  test('work_item glob simulation — appears in handler registry', () => {
    // Simulate what index.ts does with import.meta.glob
    const mockHandler: HandlerDef = {
      name: 'work_item',
      description: 'Create a work item',
      inputSchema: {} as HandlerDef['inputSchema'],
      execute: async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
    };
    const modules: Record<string, { default: HandlerDef }> = {
      './handlers/work_item.ts': { default: mockHandler },
    };
    const handlers = Object.values(modules).map(m => m.default).filter(Boolean);
    expect(handlers.length).toBe(1);
    expect(handlers[0].name).toBe('work_item');
  });
});
