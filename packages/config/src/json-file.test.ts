import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigFileError, JsonFile } from './json-file';

const path = () => join(mkdtempSync(join(tmpdir(), 'lurk-json-')), 'f.json');
const schema = z.object({ n: z.number() }).strict();

describe('JsonFile', () => {
  it('reads null for a missing file, validates on load and names the file in errors', async () => {
    const p = path();
    const f = new JsonFile(p, schema, 'test file');
    expect(await f.load()).toBeNull();
    expect(await f.version()).toBeNull();
    writeFileSync(p, '{"n":"x"}');
    await expect(f.load()).rejects.toBeInstanceOf(ConfigFileError);
    await expect(f.load()).rejects.toThrow(/not a valid test file \(n: /);
    writeFileSync(p, '{');
    await expect(f.load()).rejects.toThrow(/not valid JSON/);
  });

  it('writes saves in call order, each as the value was when saved', async () => {
    const p = path();
    const f = new JsonFile(p, schema);
    const value = { n: 1 };
    const first = f.save(value);
    value.n = 2;
    await Promise.all([first, f.save({ n: 3 })]);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ n: 3 });
    await f.save(value);
    expect(await f.load()).toEqual({ n: 2 });
  });
});
