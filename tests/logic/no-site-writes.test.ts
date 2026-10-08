import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pageModule from '../../packages/site-discourse/src/page';
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

const PAGE_IMPORT = /import\s+(?:type\s+)?\{[^}]*\bPage\b[^}]*\}\s+from\s+'playwright-core'/;
const WRITE_METHOD = /^(click|dblclick|fill|type|press|tap|check|uncheck|evaluate|dispatchEvent|setInputFiles|setChecked|selectOption|keyboard)/i;

// The adapter reaches site pages only through ReadOnlyPage; Playwright's full Page, which can type,
// click and run script, stays in the files that launch the browser or build the two narrow inputs
// (title-link click, B10 login form), plus the development-only capture and selftest commands.
describe('guard: no write paths to a site', () => {
  it('imports Playwright Page only where the browser is launched or wrapped', () => {
    const importers = ['packages', 'scripts']
      .flatMap((dir) => [...sources(join(root, dir))])
      .filter((file) => PAGE_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
      .sort();
    const allowed = [
      'packages/cli/src/capture.ts',
      'packages/cli/src/selftest.ts',
      'packages/site-discourse/src/browser.ts',
      'packages/site-discourse/src/page.ts',
      'packages/site-discourse/src/session.ts',
    ];
    expect(importers.filter((f) => !allowed.includes(f))).toEqual([]);
  });

  it('page.ts exports no method that clicks, types or runs script', () => {
    const exported = Object.keys(pageModule);
    const methods = Object.getOwnPropertyNames(pageModule.PageView.prototype);
    expect([...exported, ...methods].filter((name) => WRITE_METHOD.test(name))).toEqual([]);
  });
});
