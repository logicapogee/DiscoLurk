import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skip = new Set(['node_modules', 'dist', 'target', 'binaries', 'gen']);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) yield path;
  }
}

const lines = (dir: string) =>
  [...sources(join(root, dir))].flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((text, i) => ({ at: `${relative(root, file)}:${i + 1}`, text })),
  );

// The only input this codebase may send to a site is the B10 password login. Likes and replies are
// not part of this build, so no production code may click, fill or press anything else on a site page.
describe('guard: no write paths to a site', () => {
  it('fills and clicks only the login form and topic title links', () => {
    const allowed = [
      /SELECTORS\.loginUsername\)\.fill\(/,
      /SELECTORS\.loginPassword\)\.fill\(/,
      /SELECTORS\.loginButton\)\.click\(\)/,
      /link\.click\(\)/,
    ];
    const offenders = lines('packages')
      .filter(({ at }) => !at.startsWith('packages/cli/src/selftest.ts'))
      .filter(({ text }) => /\.(click|fill|type|press|tap|dispatchEvent|setInputFiles|setChecked|selectOption)\(|keyboard\./.test(text))
      .filter(({ text }) => !allowed.some((a) => a.test(text)));
    expect(offenders).toEqual([]);
  });

  it('never uses the like or reply controls outside read-only parsing', () => {
    const offenders = lines('packages')
      .filter(({ at }) => !/packages\/site-discourse\/src\/(selectors|parse)\.ts/.test(at))
      .filter(({ text }) => /SELECTORS\.(likeButton|replyOpen|replySubmit|replyTextarea|replyEditor)|LIKE_FALLBACK_SELECTORS/.test(text));
    expect(offenders).toEqual([]);
  });
});
