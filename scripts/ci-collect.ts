// Gathers one CI matrix leg's release files into a flat directory and records their sizes:
//   installers / updater bundles from Tauri, the single-file CLI, and on Windows a portable zip.
//   node scripts/ci-collect.ts --triple <rust triple> --name <platform name> --out <dir>
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { triple: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' } } });
if (!values.triple || !values.name || !values.out) throw new Error('usage: ci-collect.ts --triple <triple> --name <name> --out <dir>');
const { triple, name } = values;
const out = join(root, values.out);
mkdirSync(out, { recursive: true });
const windows = triple.includes('windows');
const exe = windows ? '.exe' : '';

const target = join(root, 'apps/desktop/src-tauri/target');
// `tauri build --target` writes under target/<triple>/release; a host build under target/release.
const release = [join(target, triple, 'release'), join(target, 'release')].find((d) => existsSync(join(d, 'bundle')));
if (!release) throw new Error(`No Tauri bundle directory under ${target}`);

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

// A macOS `.app` is a directory; the DMG carries it, so only flat files are published.
const wanted = /\.(exe|msi|dmg|deb|AppImage|rpm|sig|tar\.gz|zip)$/;
const collected: string[] = [];
for (const file of files(join(release, 'bundle')).filter((f) => wanted.test(f) && !f.includes('.app/'))) {
  copyFileSync(file, join(out, basename(file)));
  collected.push(basename(file));
}

const cli = join(root, 'dist/sidecar', `lurk-${triple}${exe}`);
copyFileSync(cli, join(out, `lurk-${name}${exe}`));
collected.push(`lurk-${name}${exe}`);

if (windows) {
  // The portable build is the shell plus its sidecar, which Tauri places next to it without the triple.
  const exes = readdirSync(release).filter((f) => f.endsWith('.exe')).map((f) => join(release, f));
  const zip = join(out, `DiscoLurk-${name}-portable.zip`);
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Force -DestinationPath '${zip}' -Path ${exes.map((e) => `'${e}'`).join(',')}`], { stdio: 'inherit' });
  collected.push(basename(zip));
}

const mb = (p: string) => (statSync(p).size / 1024 / 1024).toFixed(1);
const uiBytes = files(join(root, 'packages/ui/dist')).reduce((n, f) => n + statSync(f).size, 0);
const shell = readdirSync(release).find((f) => /^disco-lurk(\.exe)?$/.test(f));
const rows = [
  ...collected.map((f) => `| ${f} | ${mb(join(out, f))} MB |`),
  `| shell binary (installed) | ${shell ? `${mb(join(release, shell))} MB` : 'n/a'} |`,
  `| UI assets | ${(uiBytes / 1024 / 1024).toFixed(2)} MB |`,
  '| bundled browser | 0 MB (system Chrome / Edge) |',
];
const summary = [`### ${name} sizes`, '', '| file | size |', '|---|---|', ...rows, ''].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
