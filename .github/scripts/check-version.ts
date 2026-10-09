// Fails unless a release tag names the version the app reports:
//   node .github/scripts/check-version.ts v1.2.3[-rc.1]
// package.json holds the version; tauri.conf.json either repeats it or points at that file.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tag = process.argv[2] ?? '';
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { version?: string };

const pkg = json(join(root, 'package.json')).version;
const confPath = join(root, 'apps/desktop/src-tauri/tauri.conf.json');
const confVersion = json(confPath).version ?? '';
const tauri = confVersion.endsWith('.json') ? json(resolve(dirname(confPath), confVersion)).version : confVersion;

const problems = [
  !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag) && `tag "${tag}" is not v<semver>`,
  `v${pkg}` !== tag && `package.json version ${pkg} does not match tag ${tag}`,
  `v${tauri}` !== tag && `tauri.conf.json version ${tauri} does not match tag ${tag}`,
].filter(Boolean);
for (const p of problems) console.error(`::error title=Version mismatch::${p}`);
if (problems.length) process.exit(1);
console.log(`tag ${tag} matches package.json and tauri.conf.json`);
