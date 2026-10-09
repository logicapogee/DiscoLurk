// Bundles the CLI for the Docker image: dist/docker/lurk.cjs plus playwright-core as a real package
// directory, run by the image's own Node. The image needs no pkg binary, since Node is already there.
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'docker');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// playwright-core finds package.json, browsers.json and lib/ relative to its own directory.
const cliRequire = createRequire(join(root, 'packages/cli/package.json'));
const playwrightDir = dirname(realpathSync(cliRequire.resolve('playwright-core/package.json')));
cpSync(playwrightDir, join(outDir, 'node_modules/playwright-core'), { recursive: true, dereference: true });
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: 'lurk', version, private: true, type: 'commonjs' }));

const bundle = join(outDir, 'lurk.cjs');
await build({
  entryPoints: [join(root, 'packages/cli/src/main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  define: { __LURK_VERSION__: JSON.stringify(version) },
  // Same externals as the sidecar build: optional `ws` accelerators, BiDi (unused with CDP) and playwright-core.
  external: ['bufferutil', 'utf-8-validate', 'chromium-bidi/*', 'playwright-core'],
  logLevel: 'warning',
});
console.log(`lurk ${version} for Docker: ${(statSync(bundle).size / 1024 / 1024).toFixed(1)} MB bundle → ${outDir}`);
