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
// click and run script, stays in the files that launch the browser or build the narrow inputs
// (title-link click, like button, reply composer, B10 login form), plus the development-only
// capture and selftest commands.
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

  it('sends every click and keystroke from a named narrow input in session.ts, or from the development commands', () => {
    const WRITE_CALL = /\.(click|dblclick|fill|type|press|tap|dispatchEvent|setInputFiles|setChecked|selectOption)\(/;
    const calls = [...sources(join(root, 'packages'))].flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => WRITE_CALL.test(line))
        .map((line) => `${relative(root, file)}: ${line.trim()}`),
    );
    // Each entry names the only element that call can reach.
    const allowed = [
      /^packages\/site-discourse\/src\/session\.ts: return \{ click: \(topicId\) => .*titleLinkSelector\(topicId\)/,
      /^packages\/site-discourse\/src\/session\.ts: return \{ click: \(postNumber\) => .*likeButtonOf\(postNumber\)/,
      /^packages\/site-discourse\/src\/session\.ts: open: .*SELECTORS\.replyOpen/,
      /^packages\/site-discourse\/src\/session\.ts: fill: \(kind, text\) => .*EDITOR_SELECTORS\[kind\]/,
      /^packages\/site-discourse\/src\/session\.ts: submit: .*SELECTORS\.replySubmit/,
      /^packages\/site-discourse\/src\/session\.ts: await page\.locator\(COMPOSER_DISCARD\)/,
      /^packages\/site-discourse\/src\/session\.ts: if \(asked\) await confirm\.click/,
      /^packages\/site-discourse\/src\/session\.ts: await loginStep\('(username|password|submit)'/,
      /^packages\/site-discourse\/src\/forum\.ts: await untilAbort\(this\.opts\.titleLinks\.click\(topic\.id\), signal\);/,
      /^packages\/site-discourse\/src\/actions\.ts: await untilAbort\(this\.likeButton\.click\(postNumber\), signal\);/,
      /^packages\/site-discourse\/src\/actions\.ts: await untilAbort\(this\.composer\.fill\(kind, text\), signal\);/,
      /^packages\/cli\/src\/selftest\.ts: /,
      /^packages\/cli\/src\/capture\.ts: await link\.click\(\);/,
    ];
    expect(calls.filter((c) => !allowed.some((a) => a.test(c)))).toEqual([]);
  });

  it('reaches the like button and the composer only from performActions', () => {
    const forum = readFileSync(join(root, 'packages/site-discourse/src/forum.ts'), 'utf8');
    const uses = forum.split('\n').filter((line) => /opts\.(likeButton|composer)\b/.test(line));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain('new PageActionSurface(');
    const surfaceUses = forum.split('\n').filter((line) => /this\.actions\b/.test(line));
    expect(surfaceUses).toHaveLength(2);
    const body = forum.slice(forum.indexOf('performActions(policy: ActionPolicy'), forum.indexOf('async returnAndVerify('));
    expect(body).toContain('performActions(this.actions,');
  });

  it('page.ts exports no method that clicks, types or runs script', () => {
    const exported = Object.keys(pageModule);
    const methods = Object.getOwnPropertyNames(pageModule.PageView.prototype);
    expect([...exported, ...methods].filter((name) => WRITE_METHOD.test(name))).toEqual([]);
  });
});
