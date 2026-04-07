import { describe, test, expect } from 'bun:test';

// This handler uses Bun.spawnSync('stat', ...) directly rather than any
// mockable module, so tests operate against real files/directories in /tmp.

const { default: handler } = await import('../handlers/dod_verify_deliverable.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function tempFile(content: string): Promise<string> {
  const path = `/tmp/dod-verify-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`;
  await Bun.write(path, content);
  return path;
}

async function tempEmptyFile(): Promise<string> {
  const path = `/tmp/dod-verify-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`;
  await Bun.write(path, '');
  return path;
}

async function tempDirWithFile(): Promise<string> {
  const dir = `/tmp/dod-verify-dir-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  await Bun.write(`${dir}/inner.txt`, 'hello');
  return dir;
}

async function tempEmptyDir(): Promise<string> {
  const dir = `/tmp/dod-verify-empty-dir-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  // Create the directory by writing and removing a sentinel via Bun shell.
  await Bun.write(`${dir}/.keep`, '');
  // Now delete the file but keep the directory.
  Bun.spawnSync({ cmd: ['rm', `${dir}/.keep`] });
  return dir;
}

describe('dod_verify_deliverable handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('dod_verify_deliverable');
    expect(typeof handler.execute).toBe('function');
  });

  test('existing_file — returns exists=true, empty=false, size>0', async () => {
    const path = await tempFile('some content');
    const result = await handler.execute({ id: 'D-01', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.empty).toBe(false);
    expect(parsed.size_bytes).toBeGreaterThan(0);
    expect(parsed.is_directory).toBe(false);
    expect(parsed.id).toBe('D-01');
  });

  test('existing_empty_file — exists=true, empty=true', async () => {
    const path = await tempEmptyFile();
    const result = await handler.execute({ id: 'D-02', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.empty).toBe(true);
    expect(parsed.size_bytes).toBe(0);
  });

  test('missing_path — exists=false', async () => {
    const result = await handler.execute({
      id: 'D-03',
      evidence_path: '/tmp/definitely-nonexistent-path-xyz-987654321',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    expect(parsed.empty).toBe(true);
  });

  test('directory_with_contents — exists=true, is_directory=true, empty=false', async () => {
    const dir = await tempDirWithFile();
    const result = await handler.execute({ id: 'D-04', evidence_path: dir });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.is_directory).toBe(true);
    expect(parsed.empty).toBe(false);
  });

  test('empty_directory — exists=true, is_directory=true, empty=true', async () => {
    const dir = await tempEmptyDir();
    const result = await handler.execute({ id: 'D-05', evidence_path: dir });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.is_directory).toBe(true);
    expect(parsed.empty).toBe(true);
  });

  test('schema_validation — rejects missing id', async () => {
    const result = await handler.execute({ evidence_path: '/tmp/x' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects missing evidence_path', async () => {
    const result = await handler.execute({ id: 'D-01' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
