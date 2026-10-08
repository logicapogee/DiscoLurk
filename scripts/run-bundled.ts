// Runs a TypeScript entry that imports workspace packages, which plain `node` cannot resolve
// (their sources use extensionless imports). The bundle sits inside packages/cli so external
// playwright-core resolves from that package's dependencies.
//   node scripts/run-bundled.ts <entry.ts> [args...]
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error('usage: node scripts/run-bundled.ts <entry.ts> [args...]');
const outfile = join(root, 'packages/cli/dist', `${basename(entry, '.ts')}.dev.cjs`);
await build({
  entryPoints: [resolve(root, entry)],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: 'inline',
  external: ['bufferutil', 'utf-8-validate', 'chromium-bidi/*', 'playwright-core'],
  logLevel: 'warning',
});
const result = spawnSync(process.execPath, ['--enable-source-maps', outfile, ...args], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
