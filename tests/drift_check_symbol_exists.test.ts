import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

const { default: handler } = await import('../handlers/drift_check_symbol_exists.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

async function writeFile(name: string, content: string): Promise<string> {
  fixtureDir = `/tmp/drift-symbol-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const path = `${fixtureDir}/${name}`;
  await Bun.write(path, content);
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
  return name;
}

describe('drift_check_symbol_exists handler', () => {
  beforeEach(() => {
    fixtureDir = '';
  });
  afterEach(() => {
    fixtureDir = '';
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('drift_check_symbol_exists');
    expect(typeof handler.execute).toBe('function');
  });

  test('python_function_found', async () => {
    const file = await writeFile(
      'lib.py',
      'def hello():\n    return 1\n\ndef world():\n    return 2\n',
    );
    const result = await handler.execute({
      file_path: file,
      symbol_name: 'world',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.line_number).toBe(4);
    expect(parsed.language).toBe('python');
  });

  test('python_class_found', async () => {
    const file = await writeFile(
      'cls.py',
      'class Foo:\n    pass\n\nclass Bar:\n    pass\n',
    );
    const result = await handler.execute({
      file_path: file,
      symbol_name: 'Bar',
    });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
    expect(parsed.line_number).toBe(4);
  });

  test('typescript_exported_function', async () => {
    const file = await writeFile(
      'mod.ts',
      'export function doThing(x: number): number {\n  return x * 2;\n}\n',
    );
    const result = await handler.execute({
      file_path: file,
      symbol_name: 'doThing',
    });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
    expect(parsed.language).toBe('typescript');
  });

  test('typescript_interface_found', async () => {
    const file = await writeFile(
      'types.ts',
      'export interface Widget {\n  id: string;\n}\n',
    );
    const result = await handler.execute({
      file_path: file,
      symbol_name: 'Widget',
    });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
  });

  test('bash_function', async () => {
    const file = await writeFile(
      'script.sh',
      '#!/bin/bash\nhello() {\n  echo hi\n}\n\nfunction world {\n  echo bye\n}\n',
    );
    const r1 = await handler.execute({ file_path: file, symbol_name: 'hello' });
    expect(parseResult(r1).exists).toBe(true);
    const r2 = await handler.execute({ file_path: file, symbol_name: 'world' });
    expect(parseResult(r2).exists).toBe(true);
  });

  test('symbol_not_found_returns_false', async () => {
    const file = await writeFile('a.ts', 'export const x = 1;\n');
    const result = await handler.execute({
      file_path: file,
      symbol_name: 'nonexistent',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    expect(parsed.line_number).toBe(null);
  });

  test('auto_language_detection_by_extension', async () => {
    const file = await writeFile('svc.go', 'package main\n\nfunc main() {}\n');
    const result = await handler.execute({
      file_path: file,
      symbol_name: 'main',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.language).toBe('go');
    expect(parsed.exists).toBe(true);
  });

  test('missing_file_returns_error', async () => {
    const result = await handler.execute({
      file_path: '/tmp/nonexistent-xyz-987654.ts',
      symbol_name: 'x',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('file not found');
  });

  test('schema_validation — rejects missing symbol_name', async () => {
    const result = await handler.execute({ file_path: 'a.ts' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects invalid language', async () => {
    const result = await handler.execute({
      file_path: 'a.ts',
      symbol_name: 'x',
      language: 'cobol',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
