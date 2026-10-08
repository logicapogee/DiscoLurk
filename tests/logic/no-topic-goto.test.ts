import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const roots = ['packages', 'apps', 'scripts'];
const skip = new Set(['node_modules', 'dist', 'target', 'binaries', 'gen']);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith('.test.ts')) yield path;
  }
}

// T08 / T01: candidate topics are entered only by clicking on the list page; navigation by topic URL
// must not exist anywhere, not even as a fallback.
describe('guard: no direct navigation to topics', () => {
  it('no source file calls goto() with a topic or /t/ URL', () => {
    const offenders: string[] = [];
    for (const r of roots) {
      for (const file of sources(join(root, r))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/\.goto\([^)]*(topic|\/t\/)/i.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
