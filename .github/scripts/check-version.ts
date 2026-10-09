// Fails unless a release tag names the version every manifest declares:
//   node .github/scripts/check-version.ts v1.2.3[-rc.1]
// The installers take their version from tauri.conf.json and Cargo.toml, the CLI from the root
// package.json, so a release is consistent only when all of them agree with the tag.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tag = process.argv[2] ?? '';
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const jsonVersion = (path: string) => (JSON.parse(read(path)) as { version?: string }).version ?? '';

const cargo = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(read('apps/desktop/src-tauri/Cargo.toml'))?.[1] ?? '';

const versions: Array<[string, string]> = [
  ['package.json', jsonVersion('package.json')],
  ...readdirSync(join(root, 'packages')).map((dir): [string, string] => [`packages/${dir}/package.json`, jsonVersion(`packages/${dir}/package.json`)]),
  ['apps/desktop/package.json', jsonVersion('apps/desktop/package.json')],
  ['apps/desktop/src-tauri/tauri.conf.json', jsonVersion('apps/desktop/src-tauri/tauri.conf.json')],
  ['apps/desktop/src-tauri/Cargo.toml', cargo],
];

const problems = [
  !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag) && `tag "${tag}" is not v<semver>`,
  ...versions.map(([file, version]) => `v${version}` !== tag && `${file} version "${version}" does not match tag ${tag}`),
].filter(Boolean);
for (const p of problems) console.error(`::error title=Version mismatch::${p}`);
if (problems.length) process.exit(1);
console.log(`tag ${tag} matches ${versions.map(([file]) => file).join(', ')}`);
