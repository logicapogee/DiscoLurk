// Bundles the CLI with esbuild and packs it with @yao-pkg/pkg into the single-file `lurk`,
// named with the Rust target triple Tauri's externalBin expects.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'sidecar');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

const PKG_TARGETS: Record<string, string> = {
  'aarch64-apple-darwin': 'node24-macos-arm64',
  'x86_64-apple-darwin': 'node24-macos-x64',
  'x86_64-pc-windows-msvc': 'node24-win-x64',
  'x86_64-unknown-linux-gnu': 'node24-linux-x64',
};

function hostTriple(): string {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const triple = /^host: (\S+)$/m.exec(out)?.[1];
  if (!triple) throw new Error('Cannot read host triple from `rustc -vV`');
  return triple;
}

// Tauri sets TAURI_ENV_TARGET_TRIPLE for beforeBuildCommand, so `tauri build --target <triple>` packs the matching sidecar.
const triple = process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const pkgTarget = PKG_TARGETS[triple];
if (!pkgTarget) throw new Error(`No pkg target for ${triple}; supported: ${Object.keys(PKG_TARGETS).join(', ')}`);
const exe = triple.includes('windows') ? '.exe' : '';

// playwright-core locates package.json, browsers.json and its lib/ files relative to its own
// __dirname, so it is shipped as a real package directory inside the pkg snapshot instead of
// being inlined into the bundle.
const stage = join(outDir, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const cliRequire = createRequire(join(root, 'packages/cli/package.json'));
const playwrightDir = dirname(realpathSync(cliRequire.resolve('playwright-core/package.json')));
cpSync(playwrightDir, join(stage, 'node_modules/playwright-core'), { recursive: true, dereference: true });
// The built UI rides along for `lurk serve`, which hands it to remote browsers from `<bundle dir>/ui`.
const uiDist = join(root, 'packages/ui/dist');
if (!existsSync(join(uiDist, 'index.html'))) throw new Error('packages/ui/dist is missing; run `pnpm build:ui` first');
cpSync(uiDist, join(stage, 'ui'), { recursive: true });
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'lurk',
    version,
    bin: 'lurk.cjs',
    pkg: { assets: ['node_modules/playwright-core/**/*', 'ui/**/*'] },
  }),
);

const bundle = join(stage, 'lurk.cjs');
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
  // `bufferutil` / `utf-8-validate`: optional native accelerators of `ws`, which falls back to JS.
  // `chromium-bidi`: required lazily by playwright-core only for BiDi-over-CDP, which a CDP launch of
  // system Chrome never touches; playwright-core itself does not ship it.
  external: ['bufferutil', 'utf-8-validate', 'chromium-bidi/*', 'playwright-core'],
  logLevel: 'warning',
});

const binary = join(outDir, `lurk-${triple}${exe}`);
execFileSync(
  join(root, 'node_modules/.bin/pkg'),
  [stage, '--targets', pkgTarget, '--output', binary, '--no-bytecode', '--public', '--public-packages', '*'],
  { stdio: 'inherit' },
);

const tauriBinaries = join(root, 'apps/desktop/src-tauri/binaries');
mkdirSync(tauriBinaries, { recursive: true });
copyFileSync(binary, join(tauriBinaries, `lurk-${triple}${exe}`));

const mb = (p: string) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`lurk ${version} for ${triple}: bundle ${mb(bundle)} MB, binary ${mb(binary)} MB → ${binary}`);
